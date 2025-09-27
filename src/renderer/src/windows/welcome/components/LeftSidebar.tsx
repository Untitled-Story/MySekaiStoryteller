import { NavLink, useLocation } from 'react-router'
import logo from '@renderer/assets/logo.png'
import { BookOpen, Folder, Settings } from 'lucide-react'

export default function LeftSidebar() {
  const location = useLocation()

  const navItems = [
    { to: '/', icon: BookOpen, label: '主页' },
    { to: '/projects', icon: Folder, label: '项目' },
    { to: '/settings', icon: Settings, label: '设置' }
  ]

  return (
    <aside className="fixed top-0 left-0 h-full w-65 bg-[#FCFCFC] shadow-sm z-50 flex flex-col items-center py-4">
      <div className="flex items-center mb-5 select-none mt-4">
        <img src={logo} draggable={false} alt="Logo" className="w-7 h-7 object-contain mr-2" />
        <h1 className="text-lg font-bold">MySekaiStoryteller</h1>
      </div>
      <nav draggable={false} className="flex-1 p-3 space-y-2 w-full relative select-none">
        {navItems.map(({ to, icon: Icon, label }) => {
          const isActive = location.pathname === to
          return (
            <NavLink
              key={to}
              to={to}
              draggable={false}
              className="relative flex items-center w-full px-3 py-2 rounded-md overflow-hidden group"
            >
              <span
                className={`absolute inset-0 rounded-md ${
                  isActive
                    ? 'bg-sidebar-accent opacity-100'
                    : 'bg-sidebar-accent opacity-0 transition-opacity duration-400'
                }`}
              />

              <span className="absolute inset-0 rounded-md bg-sidebar-accent opacity-0 group-hover:opacity-40 transition-opacity duration-200" />

              <Icon
                className={`w-4 h-4 mr-3 relative z-10 transition-colors duration-300 ${
                  isActive
                    ? 'text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground group-hover:text-sidebar-accent-foreground'
                }`}
              />
              <span
                className={`relative z-10 transition-colors duration-300 ${
                  isActive
                    ? 'text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground group-hover:text-sidebar-accent-foreground'
                }`}
              >
                {label}
              </span>
            </NavLink>
          )
        })}
      </nav>
    </aside>
  )
}
