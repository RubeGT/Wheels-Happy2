# Happy Wheels

Browser-based Happy Wheels game. The entry point is `index.html`; scripts and assets are served from this repository.

The game is published at <https://rubegt.github.io/Wheels-Happy2/> using GitHub Pages from the `main` branch. This repository includes a Node.js API proxy for the game's level, replay, and user requests because Totaljerkface rejects those browser requests from the GitHub Pages origin.

## Deploying the API

Create a Render web service from this repository's `render.yaml` Blueprint and choose the free instance. The service name is `wheels-happy2-api`, matching the API URL configured in `index.html`; online levels will work once this service is deployed and these changes are published to `main`. The Render free instance sleeps after inactivity, so the first level request after a long idle period may take about a minute.

Run the API locally with `npm start` and verify it with `npm test`. The proxy only forwards the game's `get_level.hw`, `replay.hw`, and `user.hw` routes; it does not store custom levels or ratings.
