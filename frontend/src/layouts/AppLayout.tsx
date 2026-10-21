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
        <AddRepositoryModal onClose={() => setAddRepositoryOpen(false)} />
      )}
    </div>
  );
}
