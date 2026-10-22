import type { Repository } from "../types/app";
import { repositoryService } from "./repositoryService";

export async function loadDashboardRepositories(): Promise<Repository[]> {
  return repositoryService.listRepositories();
}
