import type { Repository } from "../types/app";

export async function loadDashboardRepositories(): Promise<Repository[]> {
  if (import.meta.env.DEV) {
    const { mockRepositories } = await import("./mockDashboardData");
    return mockRepositories;
  }

  return [];
}
