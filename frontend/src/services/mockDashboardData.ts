import type { Repository } from "../types/app";

export const mockRepositories: Repository[] = [
  {
    id: "repo-1",
    name: "repolens",
    owner: "acme",
    url: "https://github.com/acme/repolens",
    branches: [
      {
        id: "branch-main",
        name: "main",
        status: "ready",
        conversations: [
          {
            id: "conversation-architecture",
            title: "How does routing work?",
            updatedAt: "Today",
            messages: [
              {
                id: "message-1",
                role: "user",
                content:
                  "Can you give me an overview of how the app is organized?",
                createdAt: "10:42 AM",
              },
              {
                id: "message-2",
                role: "assistant",
                content:
                  "The frontend is organized around route-level pages, shared layout components, and small services that isolate API access. The backend keeps request handling separate from business logic, with routes delegating to controllers and services.\n\nRepository-specific source references will appear here when connected to the API.",
                createdAt: "10:42 AM",
              },
            ],
          },
          {
            id: "conversation-data",
            title: "Where is app state kept?",
            updatedAt: "Yesterday",
            messages: [],
          },
          {
            id: "conversation-loading",
            title: "Loading state preview",
            updatedAt: "Just now",
            messages: [],
            isLoading: true,
          },
        ],
      },
      {
        id: "branch-feature",
        name: "feature/dashboard-shell",
        status: "indexing",
        conversations: [],
      },
      {
        id: "branch-experiment",
        name: "experiment/parser",
        status: "failed",
        conversations: [],
      },
    ],
  },
  {
    id: "repo-2",
    name: "design-system",
    owner: "acme",
    url: "https://github.com/acme/design-system",
    branches: [
      {
        id: "branch-design-main",
        name: "main",
        status: "ready",
        conversations: [],
      },
    ],
  },
];
