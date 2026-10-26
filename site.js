const API_BASE = document.documentElement.dataset.apiBase.replace(/\/+$/, "");
const TOKEN_KEY = "wheelsHappyAccessToken";
const accountDialog = document.querySelector("#account-dialog");
const accountForm = document.querySelector("#account-form");
let accountMode = "login";

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setMessage(element, message, success = false) {
  element.textContent = message;
  element.classList.toggle("success", success);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set("content-type", "application/json");
  if (getToken()) headers.set("authorization", `Bearer ${getToken()}`);
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}

function updateAccountUi(user) {
  const signedIn = Boolean(user && getToken());
  document.querySelector("#account-name").textContent =
    user?.user_metadata?.username || user?.email || "";
  document.querySelector("#account-name").hidden = !signedIn;
  document.querySelector("#login-open").hidden = signedIn;
  document.querySelector("#signup-open").hidden = signedIn;
  document.querySelector("#logout").hidden = !signedIn;
}

function setAccountMode(mode) {
  accountMode = mode;
  const signup = mode === "signup";
  document.querySelector("#account-eyebrow").textContent = signup ? "JOIN THE COMMUNITY" : "YOUR PLAYER ACCOUNT";
  document.querySelector("#account-title").textContent = signup ? "Create your account" : "Welcome back";
  document.querySelector("#account-copy").textContent =
    "This unofficial fan-site account lets you rate levels and publish your levels from the in-game editor.";
  document.querySelector("#username-field").hidden = !signup;
  accountForm.elements.password.autocomplete = signup ? "new-password" : "current-password";
  document.querySelector("#account-submit").textContent = signup ? "Create account" : "Log in";
  document.querySelector("#account-switch").textContent = signup
    ? "Already have an account? Log in"
    : "Need an account? Sign up";
  setMessage(document.querySelector("#account-message"), "");
}

document.querySelector("#login-open").addEventListener("click", () => {
  setAccountMode("login");
  accountDialog.showModal();
});
document.querySelector("#signup-open").addEventListener("click", () => {
  setAccountMode("signup");
  accountDialog.showModal();
});
document.querySelector("#account-switch").addEventListener("click", () => {
  setAccountMode(accountMode === "login" ? "signup" : "login");
});
document.querySelectorAll(".dialog-close").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});
accountForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(accountForm);
  const message = document.querySelector("#account-message");
  const submit = document.querySelector("#account-submit");
  submit.disabled = true;
  setMessage(message, accountMode === "signup" ? "Creating your account…" : "Signing in…");
  try {
    const path = accountMode === "signup" ? "/api/auth/signup" : "/api/auth/login";
    const body = {
      email: formData.get("email"),
      password: formData.get("password")
    };
    if (accountMode === "signup") body.username = formData.get("username");
    const result = await api(path, { method: "POST", body: JSON.stringify(body) });
    if (!result.access_token) {
      setMessage(message, "Account created. Check your email to confirm it, then log in.", true);
      accountForm.reset();
      return;
    }
    localStorage.setItem(TOKEN_KEY, result.access_token);
    accountDialog.close();
    accountForm.reset();
    updateAccountUi(result.user);
  } catch (error) {
    setMessage(
      message,
      error.message === "Account and level publishing are not configured yet"
        ? "Accounts aren't connected yet. The site needs Supabase set up before sign-up can work."
        : error.message
    );
  } finally {
    submit.disabled = false;
  }
});

document.querySelector("#logout").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch (error) {
    console.warn("Could not end the remote session:", error);
  } finally {
    localStorage.removeItem(TOKEN_KEY);
    updateAccountUi(null);
  }
});

async function restoreSession() {
  const token = getToken();
  if (!token) return;
  try {
    const user = await api("/api/auth/me");
    updateAccountUi(user);
  } catch {
    localStorage.removeItem(TOKEN_KEY);
    updateAccountUi(null);
  }
}

updateAccountUi(null);
restoreSession();
