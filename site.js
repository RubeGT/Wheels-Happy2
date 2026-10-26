const API_BASE = document.documentElement.dataset.apiBase.replace(/\/+$/, "");
const TOKEN_KEY = "wheelsHappyAccessToken";
const USER_KEY = "wheelsHappyUser";
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
  document.querySelector("#replays-open").hidden = !signedIn;
  document.querySelector("#account-tools").hidden = !signedIn;
  document.querySelector("#login-open").hidden = signedIn;
  document.querySelector("#signup-open").hidden = signedIn;
  document.querySelector("#logout").hidden = !signedIn;
  if (signedIn) loadReplays();
  else document.querySelector("#replays-list").replaceChildren();
}

function setAccountMode(mode) {
  accountMode = mode;
  const signup = mode === "signup";
  document.querySelector("#account-eyebrow").textContent = signup ? "JOIN THE COMMUNITY" : "YOUR PLAYER ACCOUNT";
  document.querySelector("#account-title").textContent = signup ? "Create your account" : "Welcome back";
  document.querySelector("#account-copy").textContent =
    "Sign in to rate levels, save replays, and publish your levels from the in-game editor.";
  document.querySelector("#username-field").hidden = !signup;
  accountForm.elements.password.autocomplete = signup ? "new-password" : "current-password";
  document.querySelector("#account-submit").textContent = signup ? "Create account" : "Log in";
  document.querySelector("#account-switch").textContent = signup
    ? "Already have an account? Log in"
    : "Need an account? Sign up";
  setMessage(document.querySelector("#account-message"), "");
}

async function loadReplays() {
  const status = document.querySelector("#replays-status");
  const list = document.querySelector("#replays-list");
  if (!getToken()) return;
  status.textContent = "Loading your saved replays…";
  list.replaceChildren();
  try {
    const replays = await api("/api/me/replays");
    if (!Array.isArray(replays) || replays.length === 0) {
      status.textContent = "No saved replays yet. Save one from the game's replay menu.";
      return;
    }
    status.textContent = `${replays.length} saved ${replays.length === 1 ? "replay" : "replays"}`;
    for (const replay of replays) {
      const card = document.createElement("article");
      card.className = "level-card";
      const title = document.createElement("h3");
      title.textContent = replay.level_id ? `Replay for level ${replay.level_id}` : "Saved game replay";
      const description = document.createElement("p");
      description.textContent = `Saved ${new Date(replay.created_at).toLocaleString()}`;
      const meta = document.createElement("div");
      meta.className = "level-meta";
      const replayId = document.createElement("span");
      replayId.textContent = `Replay #${replay.id}`;
      const download = document.createElement("button");
      download.className = "text-button";
      download.type = "button";
      download.textContent = "Download backup";
      download.addEventListener("click", () => downloadReplay(replay.id, download));
      meta.append(replayId, download);
      card.append(title, description, meta);
      list.append(card);
    }
  } catch (error) {
    status.textContent = error.message;
  }
}

async function downloadReplay(replayId, button) {
  button.disabled = true;
  try {
    const replay = await api(`/api/me/replays/${encodeURIComponent(replayId)}`);
    const blob = new Blob([JSON.stringify(replay, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `happy-wheels-replay-${replayId}.json`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    document.querySelector("#replays-status").textContent = error.message;
  } finally {
    button.disabled = false;
  }
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
document.querySelector("#replays-open").addEventListener("click", () => {
  document.querySelector("#account-tools").scrollIntoView({ behavior: "smooth" });
});
document.querySelector("#refresh-replays").addEventListener("click", loadReplays);

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
    localStorage.setItem(USER_KEY, JSON.stringify(result.user));
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
    localStorage.removeItem(USER_KEY);
    updateAccountUi(null);
  }
});

async function restoreSession() {
  const token = getToken();
  if (!token) return;
  try {
    const user = await api("/api/auth/me");
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    updateAccountUi(user);
  } catch {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    updateAccountUi(null);
  }
}

updateAccountUi(null);
restoreSession();
