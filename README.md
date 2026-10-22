# RepoLens

RepoLens is a workspace for exploring and understanding software repositories. This initial setup provides the frontend, API, and local infrastructure; product features will be added in later steps.

## Prerequisites

- Node.js 20.19+ or 22.12+ and npm
- Docker Desktop (for PostgreSQL and Redis)

## Getting started

1. Copy the repository-root `.env.example` to the repository-root `.env` and set a unique `SESSION_SECRET` using a secure random generator (at least 32 characters). This single root `.env` is used by Docker Compose, Prisma, the backend, and Vite; keep it private.

2. Install workspace dependencies:

   ```sh
   npm run bootstrap
   ```

3. Start the local services:

   ```sh
   docker compose up -d
   ```

   PostgreSQL uses host port `5433` to avoid colliding with local PostgreSQL installations; Redis uses host port `6380`.

4. Run the frontend and backend in development mode:

   ```sh
   npm run dev
   ```

   The Vite frontend is available at <http://127.0.0.1:5173> and the API at <http://127.0.0.1:3001>. The health endpoint is `GET http://127.0.0.1:3001/api/health`.

## Development commands

| Command                                                    | Description                                  |
| ---------------------------------------------------------- | -------------------------------------------- |
| `npm run bootstrap`                                        | Install all workspace dependencies           |
| `npm run dev`                                              | Run frontend and backend concurrently        |
| `npm run dev:frontend`                                     | Run only the Vite frontend                   |
| `npm run dev:backend`                                      | Run only the backend with automatic restarts |
| `npm run build`                                            | Build both applications                      |
| `npm run build:frontend` / `npm run build:backend`         | Build one application                        |
| `npm run typecheck`                                        | Type-check both applications                 |
| `npm run typecheck:frontend` / `npm run typecheck:backend` | Type-check one application                   |
| `npm run lint`                                             | Lint the workspace                           |
| `npm run format:check`                                     | Check formatting with Prettier               |

Stop local services with `docker compose down`. PostgreSQL data is stored in the `postgres_data` Docker volume and is retained when containers stop.

## Frontend preview

Development-only repository/conversation sample data can be shown after signing in. It does not connect to GitHub or the backend. The repository dialog validates GitHub URL format, but repository checks, branch resolution, indexing, and account/quota enforcement require future API work; chat is not connected yet.

## Authentication

Email/password registration and login use server-side sessions stored in Redis. The session cookie is HTTP-only; passwords and session identifiers are never stored by the frontend. Authentication requests use a session-bound CSRF token and are rate-limited. `FRONTEND_ORIGIN` must exactly match the browser origin. For a cross-site production deployment, configure `COOKIE_SECURE=true` and `COOKIE_SAME_SITE=none` and serve both sites over HTTPS.

The API routes are `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, and `GET /api/auth/me`. The frontend requests a CSRF token from `GET /api/auth/csrf` before state-changing authentication calls.

## Database and Prisma

PostgreSQL is configured with the `pgvector` extension available, and Redis is provided for BullMQ jobs. Prisma 7 configuration and a PostgreSQL driver-adapter factory are scaffolded in the backend. The schema intentionally contains no application models yet. Do not run Prisma client generation or migrations until the finalized application schema is added.

The migration command is `npm run prisma:migrate:dev --workspace=backend`; deploy migrations with `npm run prisma:migrate:deploy --workspace=backend` once a schema and migrations exist. Create migrations from the backend workspace with `npm run prisma:migrate:create --workspace=backend -- --name <migration-name>`. Prisma migrations will be stored in `database/migrations`.

## Current scope

This is setup scaffolding only. The frontend provides routing and a development-preview dashboard. The backend includes the Tree-sitter runtime, but language grammars and parsing flows are deferred. Authentication, GitHub integration, repository indexing, chat APIs, embeddings, and AI-provider calls are not implemented.
