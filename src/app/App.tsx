import { NavLink } from "react-router";
import { DESKTOP_NAV_ITEMS } from "./navigation";
import { AppRoutes } from "./routes";

export function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <strong>OpsMate</strong>
        <nav aria-label="Primary">
          <ul className="nav-list">
            {DESKTOP_NAV_ITEMS.map((item) => (
              <li key={item.path}>
                <NavLink to={item.path}>{item.label}</NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main className="app-main">
        <AppRoutes />
      </main>
    </div>
  );
}
