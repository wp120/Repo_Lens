# RepoLens

RepoLens is an AI-assisted workspace for exploring GitHub repositories. It ingests public repository branches, indexes source files into PostgreSQL with `pgvector`, and supports branch-scoped conversations with cited answers.

## Features

- Email/password registration, login, logout, and Redis-backed sessions
- Public GitHub repository and branch resolution
- BullMQ repository ingestion with a retrying background worker
- Tree-sitter-based source chunking with configurable ingestion limits
- Voyage embeddings stored as 1024-dimensional vectors
- Repository-wide retrieval for conversational questions
- Conversation creation, history, renaming, deletion, and idempotent message sending
- Source citations linked to repository files, commit SHAs, and line ranges
- React/Vite dashboard with repository, branch, indexing, and conversation states

## Technology stack

- **Frontend:** React 19, React Router, TypeScript, and Vite
- **Backend:** Node.js, Express 5, TypeScript, Prisma 7, and BullMQ
- **Data stores:** PostgreSQL 17 with `pgvector`, Redis, and a Redis-backed session store
- **AI and source processing:** Voyage embeddings, OpenAI-compatible chat providers, GitHub REST API, and Tree-sitter

## Repository layout

```text
frontend/src/       React application, pages, layouts, components, services, and routes
backend/src/        Express API, authentication, ingestion, retrieval, and conversation logic
backend/src/jobs/   BullMQ queue and ingestion worker
backend/src/tests/  Backend unit and integration-style tests
database/migrations Prisma SQL migrations
database/init/      PostgreSQL pgvector initialization
```

## Prerequisites

- Node.js 20.19+ or 22.12+ and npm
- Docker Desktop or another Docker Compose installation
- A GitHub access token for repository access
- Voyage API credentials for embedding generation
- API credentials for the configured AI chat provider

## Local setup

1. Copy the environment template:

   ```sh
   Copy-Item .env.example .env
   ```

   On macOS or Linux, use `cp .env.example .env`.

2. Update `.env` with credentials and secrets:

   - Set `SESSION_SECRET` to a unique random value of at least 32 characters.
   - Set `GITHUB_TOKEN` to a GitHub token that can read public repositories.
   - Set `VOYAGE_API_KEY` and the embedding/chat values supported by your provider.
   - Keep local service URLs and ports unchanged unless Docker Compose was customized.

   The repository-root `.env` is loaded by the backend and used by Prisma. Keep it private and do not commit credentials.

3. Install workspace dependencies:

   ```sh
   npm run bootstrap
   ```

4. Start PostgreSQL and Redis:

   ```sh
   docker compose up -d
   ```

   PostgreSQL uses host port `5433`; Redis uses host port `6380`. Their Docker volumes preserve local data.

5. Apply the database migrations:

   ```sh
   npm run prisma:migrate:deploy --workspace=backend
   ```

6. Start the frontend and backend:

   ```sh
   npm run dev
   ```

The frontend is available at <http://127.0.0.1:5173>. The API listens on <http://127.0.0.1:3001> by default.

Check the backend with:

```sh
curl http://127.0.0.1:3001/api/health
```

## Development commands

| Command                            | Description                                                  |
| ---------------------------------- | ------------------------------------------------------------ |
| `npm run bootstrap`                | Install workspace dependencies                               |
| `npm run dev`                      | Run the frontend and backend concurrently                    |
| `npm run dev:frontend`             | Run only the Vite frontend                                   |
| `npm run dev:backend`              | Run the backend and ingestion worker with automatic restarts |
| `npm run build`                    | Build both applications                                      |
| `npm run build:frontend`           | Build the frontend                                           |
| `npm run build:backend`            | Build the backend                                            |
| `npm run typecheck`                | Type-check both applications                                 |
| `npm run typecheck:frontend`       | Type-check the frontend                                      |
| `npm run typecheck:backend`        | Type-check the backend                                       |
| `npm run test --workspace=backend` | Run backend tests                                            |
| `npm run lint`                     | Lint the workspace                                           |
| `npm run format`                   | Format files with Prettier                                   |
| `npm run format:check`             | Check workspace formatting                                   |

Useful Prisma commands:

| Command                                             | Description                        |
| --------------------------------------------------- | ---------------------------------- |
| `npm run prisma:generate --workspace=backend`       | Generate the Prisma client         |
| `npm run prisma:validate --workspace=backend`       | Validate the Prisma schema         |
| `npm run prisma:migrate:deploy --workspace=backend` | Apply committed migrations         |
| `npm run prisma:migrate:dev --workspace=backend`    | Create and apply a local migration |
| `npm run prisma:studio --workspace=backend`         | Open Prisma Studio                 |

Stop local containers with `docker compose down`. Add `-v` only when local PostgreSQL and Redis data should also be deleted.

## Repository ingestion

After signing in, submit a public GitHub repository or branch URL from **Add repository**. RepoLens resolves the repository's default branch when no branch is present and verifies public repository access.

The backend checks repository and file limits before enqueueing the branch. Once submitted, the BullMQ worker:

1. Downloads the repository tree and source files.
2. Chunks source code with the configured language support.
3. Generates embeddings for each chunk.
4. Stores chunks and vectors in PostgreSQL.
5. Marks the branch `ready`, or `failed` with an error that is visible in the dashboard.

Private repositories and GitHub OAuth connections are not currently supported by the UI.

## Conversations

Ready branches can be assigned conversations. Conversations are private to the signed-in user and are stored with their messages and citations.

Sending a message:

- searches relevant indexed chunks,
- uses the configured chat provider to answer the repository question,
- persists the assistant response,
- and returns source citations for the supporting code.

Duplicate message submissions can be deduplicated by a client message ID.

## Authentication and security

Email/password accounts use bcrypt password hashes. Sessions are stored in Redis, with session identifiers kept in an HTTP-only cookie.

State-changing authenticated requests require a CSRF token obtained from `GET /api/auth/csrf`. Authentication and CSRF endpoints are also rate-limited. Set `FRONTEND_ORIGIN` to the exact browser origin that may call the API.

For production:

- Serve both frontend and API over HTTPS.
- Set `COOKIE_SECURE=true`.
- Set `COOKIE_SAME_SITE=none` for cross-site cookies.
- Use a strong, stable `SESSION_SECRET`.
- Restrict and rotate external API credentials.

## API overview

| Method   | Route                              | Purpose                                   |
| -------- | ---------------------------------- | ----------------------------------------- |
| `GET`    | `/api/health`                      | API and dependency health                 |
| `POST`   | `/api/auth/register`               | Register an account                       |
| `POST`   | `/api/auth/login`                  | Start a session                           |
| `POST`   | `/api/auth/logout`                 | End a session                             |
| `GET`    | `/api/auth/me`                     | Get the current user                      |
| `GET`    | `/api/auth/csrf`                   | Get a session CSRF token                  |
| `GET`    | `/api/repositories`                | List accessible repositories and branches |
| `POST`   | `/api/repositories/resolve`        | Resolve a GitHub repository URL           |
| `POST`   | `/api/repositories/ingest`         | Start branch ingestion                    |
| `GET`    | `/api/conversations?branchId=<id>` | List branch conversations                 |
| `POST`   | `/api/conversations`               | Create a conversation                     |
| `GET`    | `/api/conversations/:id`           | Retrieve conversation history             |
| `PATCH`  | `/api/conversations/:id`           | Rename a conversation                     |
| `DELETE` | `/api/conversations/:id`           | Delete a conversation                     |
| `POST`   | `/api/conversations/:id/messages`  | Send a user message                       |

Repository and conversation routes require authentication. Most state-changing routes also require the session CSRF token.

## Environment variables

The following variables are available in `.env.example`. Provider-specific values can remain empty when the corresponding feature is not used locally.

| Variable              | Purpose                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `DATABASE_URL`        | PostgreSQL connection string                                     |
| `REDIS_URL`           | Redis connection string                                          |
| `SESSION_SECRET`      | Redis session signing secret                                     |
| `SESSION_COOKIE_NAME` | Session cookie name                                              |
| `FRONTEND_ORIGIN`     | Allowed Vite/browser origin                                      |
| `VITE_API_URL`        | Optional frontend API base URL                                   |
| `COOKIE_SECURE`       | Enables secure cookies                                           |
| `COOKIE_SAME_SITE`    | Cookie SameSite policy                                           |
| `PORT`                | Backend API port                                                 |
| `GITHUB_TOKEN`        | GitHub REST API token                                            |
| `VOYAGE_API_KEY`      | Voyage embeddings API key                                        |
| `AI_PROVIDER`         | Chat provider, such as the configured OpenAI-compatible provider |
| `AI_API_KEY`          | Chat provider API key                                            |
| `AI_CHAT_MODEL`       | Chat model identifier                                            |
| `AI_EMBEDDING_MODEL`  | Embedding model identifier, if used by provider configuration    |
| `AI_BASE_URL`         | Optional OpenAI-compatible provider base URL                     |

Ingestion limits and retrieval tuning can also be configured with environment variables. See `backend/src/config/ingestionLimits.ts`, `backend/src/config/voyageRateLimits.ts`, and [background jobs](backend/src/jobs/README.md) for defaults.

## Database and migrations

The PostgreSQL database uses the `pgvector` extension from `database/init/001-enable-pgvector.sql`. Prisma models cover users, repositories, branch indexes, user access, ingestions, code chunks, conversations, messages, and citations.

Committed migration files are stored under `database/migrations`. For local schema changes:

```sh
npm run prisma:migrate:dev --workspace=backend
```

Use a descriptive migration name when prompted.
