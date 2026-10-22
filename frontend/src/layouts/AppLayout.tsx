import { useState } from "react";
import { Outlet } from "react-router-dom";
import { AddRepositoryModal } from "../components/AddRepositoryModal";
import { AppHeader } from "../components/AppHeader";
import { AppSidebar } from "../components/AppSidebar";
import { useDashboardRepositories } from "../hooks/useDashboardRepositories";

export function AppLayout() {
  const { repositories, setRepositories, error } = useDashboardRepositories();
  const [isAddRepositoryOpen, setAddRepositoryOpen] = useState(false);
  const [isSidebarOpen, setSidebarOpen] = useState(false);

  function attachRepository(repository: (typeof repositories)[number]) {
    setRepositories((current) => {
      const existing = current.find((item) => item.id === repository.id);
      if (!existing) return [...current, repository];
      const branch = repository.branches[0];
      if (existing.branches.some((item) => item.id === branch.id)) {
        return current.map((item) =>
          item.id === repository.id
            ? {
                ...item,
                branches: item.branches.map((currentBranch) =>
                  currentBranch.id === branch.id ? branch : currentBranch,
                ),
              }
            : item,
        );
      }
      return current.map((item) =>
        item.id === repository.id
          ? { ...item, branches: [...item.branches, branch] }
          : item,
      );
    });
  }

  return (
    <div className="app-shell">
      <AppHeader onToggleSidebar={() => setSidebarOpen((open) => !open)} />
      <div className="app-body">
        <AppSidebar
          isOpen={isSidebarOpen}
          onAddRepository={() => setAddRepositoryOpen(true)}
          onClose={() => setSidebarOpen(false)}
          onRepositoriesChange={setRepositories}
          repositories={repositories}
        />
        <main className="main-content">
          {error && (
            <div className="data-error" role="alert">
              Repository data could not be loaded: {error}
            </div>
          )}
          <Outlet
            context={{
              repositories,
              onAddRepository: () => setAddRepositoryOpen(true),
            }}
          />
          <footer className="app-footer">
            <span>RepoLens · Your code, in focus.</span>
            <span>Repository intelligence for your team</span>
          </footer>
        </main>
      </div>
      {isAddRepositoryOpen && (
        <AddRepositoryModal
          onClose={() => setAddRepositoryOpen(false)}
          onRepositoryAttached={attachRepository}
        />
      )}
    </div>
  );
}
