# Happy Wheels

Browser-based Happy Wheels fan project. The website at `index.html` embeds the game from `game.html`, with account controls and a community level list. GitHub Pages serves the site at <https://rubegt.github.io/Wheels-Happy2/>.

The Node.js API in `api/server.js` proxies the original game's level, replay, and user requests, and provides Supabase-backed accounts. Signed-in players can rate levels and create, update, and publish levels from the in-game editor. The game's native replay features continue to use the original replay service. Published custom levels are added to the game's level catalog and their original game-format records are served by the API.

## Configure Supabase

1. Create a Supabase project and run `supabase/schema.sql` in its SQL Editor. It creates private `game_levels`, `level_ratings`, and legacy replay-backup tables with row-level security enabled. New game replay requests use the original replay service. The API uses the service-role key server-side; do not add public table policies or expose that key to the browser.
2. In the Render dashboard, set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` from the project API settings. The service-role key must remain a Render secret and must never be committed or sent to the browser.
3. In Supabase Auth URL Configuration, allow `https://rubegt.github.io/Wheels-Happy2/` as a redirect URL for email confirmation.
4. Keep `ALLOWED_ORIGINS` set to `https://rubegt.github.io`. Add a local development origin only when needed.
5. Deploy the Render service. The account endpoints return a clear configuration error until all three Supabase values are set.

Supabase's free tier has limits rather than unlimited storage. Email confirmation can be enabled in Supabase Auth; when enabled, new users must confirm their email before logging in. The game uses 32-bit level identifiers, so the custom-level identity sequence starts at `1900000000`.

## Development

Run the API locally with `npm start` and run its tests with `npm test`. The free Render instance sleeps after inactivity, so the first request after a long idle period may take about a minute.
