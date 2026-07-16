import type { JSX } from 'react'
import { NavLink, useLocation } from 'react-router'
import logo from '@/assets/logo.png'
import type { LucideIcon } from 'lucide-react'
import { BadgeInfo, BookOpen, Folder, Settings } from 'lucide-react'

type SidebarNavItem = {
  to: string
  icon: LucideIcon
  label: string
}

export default function LeftSidebar(): JSX.Element {
  const location = useLocation()

  const navItems: readonly SidebarNavItem[] = [
    { to: '/', icon: BookOpen, label: '主页' },
    { to: '/projects', icon: Folder, label: '项目' },
    { to: '/settings', icon: Settings, label: '设置' },
    { to: '/about', icon: BadgeInfo, label: '关于与鸣谢' }
  ]

  return (
    <aside className="fixed top-0 left-0 h-full w-65 border-r border-sidebar-border bg-sidebar text-sidebar-foreground shadow-sm z-50 flex flex-col items-center py-4 transition-colors duration-300">
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
              data-tour={
                to === '/projects'
                  ? 'main-projects'
                  : to === '/settings'
                    ? 'main-settings'
                    : undefined
              }
              draggable={false}
              aria-current={isActive ? 'page' : undefined}
              className={`relative flex items-center w-full px-3 py-2 rounded-md transition-colors duration-200 ${
                isActive
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-foreground hover:bg-sidebar-accent/40 hover:text-sidebar-accent-foreground'
              }`}
            >
              <Icon className="w-4 h-4 mr-3" />
              <span>{label}</span>
            </NavLink>
          )
        })}
      </nav>
    </aside>
  )
}
