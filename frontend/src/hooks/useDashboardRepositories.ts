import { useEffect, useState } from "react";
import { loadDashboardRepositories } from "../services/dashboardDataService";
import type { Repository } from "../types/app";

export function useDashboardRepositories() {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [error, setError] = useState<string | null>(null);
  const isIndexing = repositories.some((repository) =>
    repository.branches.some((branch) => branch.status === "indexing"),
  );

  useEffect(() => {
    let active = true;
    loadDashboardRepositories()
      .then((data) => {
        if (active) setRepositories(data);
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not load repositories.",
          );
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!isIndexing) return;

    let active = true;
    let timeout: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const data = await loadDashboardRepositories();
        if (active) {
          setRepositories(data);
          setError(null);
        }
      } catch (reason: unknown) {
        if (active) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not refresh repository status.",
          );
        }
      } finally {
        if (active) {
          timeout = setTimeout(() => void refresh(), 5000);
        }
      }
    };

    timeout = setTimeout(() => void refresh(), 5000);
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [isIndexing]);

  return { repositories, setRepositories, error };
}
