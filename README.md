# RepoLens

RepoLens is a workspace for exploring and understanding software repositories. This initial setup provides the frontend, API, and local infrastructure; product features will be added in later steps.

## Prerequisites

- Node.js 20.19+ or 22.12+ and npm
- Docker Desktop (for PostgreSQL and Redis)

## Getting started

1. Install workspace dependencies:

   ```sh
   npm run bootstrap
   ```

2. Copy `.env.example` to `.env` and adjust values if needed.

3. Start the local services:

   ```sh
   docker compose up -d
   ```

4. Run the frontend and backend in development mode:

   ```sh
   npm run dev
   ```

   The Vite frontend is available at <http://localhost:5173> and the API at <http://localhost:3001>. The health endpoint is `GET http://localhost:3001/api/health`.

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

In development, open `/login` and choose **Open preview** to view the sample dashboard. The preview session and repository/conversation data are development-only and do not connect to GitHub or the backend. Production builds do not include the preview login or sample repository data. The repository dialog validates GitHub URL format, but repository checks, branch resolution, indexing, and account/quota enforcement require future API work; chat and authentication are not connected yet.

## Database and Prisma

PostgreSQL is configured with the `pgvector` extension available, and Redis is provided for BullMQ jobs. Prisma 7 configuration and a PostgreSQL driver-adapter factory are scaffolded in the backend. The schema intentionally contains no application models yet. Do not run Prisma client generation or migrations until the finalized application schema is added.

The migration command is `npm run prisma:migrate:dev --workspace=backend`; deploy migrations with `npm run prisma:migrate:deploy --workspace=backend` once a schema and migrations exist. Create migrations from the backend workspace with `npm run prisma:migrate:create --workspace=backend -- --name <migration-name>`. Prisma migrations will be stored in `database/migrations`.

## Current scope

This is setup scaffolding only. The frontend provides routing and a development-preview dashboard. The backend includes the Tree-sitter runtime, but language grammars and parsing flows are deferred. Authentication, GitHub integration, repository indexing, chat APIs, embeddings, and AI-provider calls are not implemented.
