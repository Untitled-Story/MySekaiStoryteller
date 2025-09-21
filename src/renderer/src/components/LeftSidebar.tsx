import { NavLink } from 'react-router'
import logo from '@renderer/assets/logo.png'
import { BookOpen, Folder, Settings } from 'lucide-react'

export default function LeftSidebar() {
  return (
    <aside className="fixed top-0 left-0 h-full w-65 bg-[#FCFCFC] shadow-sm z-50 flex flex-col items-center py-4">
      <div className="flex items-center mb-5 select-none mt-4">
        <img src={logo} alt="Logo" className="w-7 h-7 object-contain pointer-events-none mr-2" />
        <h1 className="text-lg font-bold">MySekaiStoryteller</h1>
      </div>
      <nav className="flex-1 p-3 space-y-2 w-full">
        <NavLink
          to="/"
          className={({ isActive }) =>
            `flex items-center w-full px-3 py-2 rounded-md ${
              isActive
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
            }`
          }
        >
          <BookOpen className="w-4 h-4 mr-3" />
          主页
        </NavLink>

        <NavLink
          to="/projects"
          className={({ isActive }) =>
            `flex items-center w-full px-3 py-2 rounded-md ${
              isActive
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
            }`
          }
        >
          <Folder className="w-4 h-4 mr-3" />
          项目
        </NavLink>

        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `flex items-center w-full px-3 py-2 rounded-md ${
              isActive
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
            }`
          }
        >
          <Settings className="w-4 h-4 mr-3" />
          设置
        </NavLink>
      </nav>
    </aside>
  )
}
