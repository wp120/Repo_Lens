import { useEffect, useState } from "react";
import { loadDashboardRepositories } from "../services/dashboardDataService";
import type { Repository } from "../types/app";

export function useDashboardRepositories() {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  return { repositories, setRepositories, error };
}
