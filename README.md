# Baby Tracker

Try the [dummy demo](https://nstambovsky.github.io/baby-tracker-demo/), then clone this repository to run your own private app. MIT licensed: use, modify, and host your own copy.

- **Root:** a static portfolio demo with fictional data. Edits stay in this tab’s memory and reset on refresh. No account, password, backend, or live data connection.
- **self-hosted/:** the real password-protected Cloudflare Worker + D1 app, starting with an empty database. You supply your own Cloudflare account and secrets.

## Use it yourself

```sh
git clone https://github.com/NStambovsky/baby-tracker-demo.git
cd baby-tracker-demo
```

Follow [Cloudflare setup](docs/CLOUDFLARE.md), [phone home-screen instructions](docs/PHONE.md), or give your coding agent [AGENTS.md](AGENTS.md). Neither edition contains the author’s personal records or credentials. Self-hosted records belong in your own private database, never in Git.

## Try the demo locally

```sh
npm start
```

Open http://localhost:8080. Python 3 required. `npm test` runs the demo checks with Node 22+. The deployed private app needs Node 22+ for the pinned setup tooling.

## Features

Feeding and sleep timers, bottle amounts, diaper logs, notes, weight and height measurements, editable history, filters, and charts. Two phones can share one deployment and password.

The public demo does not save real records. The private app is a personal shared-password tool, not a service with separate user accounts. Hosting and optional AI usage are charged to whoever deploys it under their provider’s current terms.
