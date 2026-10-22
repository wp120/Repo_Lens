# RepoLens

RepoLens is a workspace for exploring and understanding software repositories. The project includes a React frontend, an Express API, PostgreSQL persistence, and Redis-backed sessions and jobs.

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

## Add a repository

After signing in, use **Add repository** to submit a public GitHub repository URL or branch URL. The backend validates the URL and verifies the public repository and branch with GitHub's API. Repository URLs without a branch resolve to the repository's actual default branch. Private repositories are not supported.

If the resolved branch already has a ready index, it is attached to the signed-in user's dashboard. Existing queued/indexing branches reuse their current status. For a new or previously failed branch, the UI asks for confirmation; confirming currently only logs `Ingestion confirmed.` and starts no work. Ingestion, retries, conversations, and chat remain out of scope.

## Authentication

Email/password registration and login use server-side sessions stored in Redis. The session cookie is HTTP-only; passwords and session identifiers are never stored by the frontend. Authentication requests use a session-bound CSRF token and are rate-limited. `FRONTEND_ORIGIN` must exactly match the browser origin. For a cross-site production deployment, configure `COOKIE_SECURE=true` and `COOKIE_SAME_SITE=none` and serve both sites over HTTPS.

The API routes are `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, and `GET /api/auth/me`. The frontend requests a CSRF token from `GET /api/auth/csrf` before state-changing authentication calls.

## Database and Prisma

PostgreSQL is configured with the `pgvector` extension available, and Redis is provided for BullMQ jobs and server-side sessions. Prisma 7 uses the PostgreSQL driver adapter. The schema includes users plus the repository, branch-index, and user-branch-access models needed for authentication and the Add Repository flow; other finalized application models remain to be added.

Apply committed migrations with `npm run prisma:migrate:deploy --workspace=backend`. For local schema changes, use `npm run prisma:migrate:dev --workspace=backend`; create migrations with `npm run prisma:migrate:create --workspace=backend -- --name <migration-name>`. Prisma migrations are stored in `database/migrations`.

## Current scope

The Add Repository flow uses GitHub's public REST API for repository and branch verification. GitHub OAuth, private repository access, repository ingestion/indexing, language parsing, chat APIs, embeddings, and AI-provider calls are not implemented.
