import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router'
import logo from '@/assets/logo.png'
import type { LucideIcon } from 'lucide-react'
import { BadgeInfo, BookOpen, Folder, Menu, Settings, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/style'

type SidebarNavItem = {
  to: string
  icon: LucideIcon
  label: string
}

export type LeftSidebarMode = 'rail' | 'drawer' | 'bottom'

export default function LeftSidebar({ mode = 'rail' }: { mode?: LeftSidebarMode }): JSX.Element {
  const { t } = useTranslation()
  const location = useLocation()
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false)

  useEffect((): void => {
    setDrawerOpen(false)
  }, [location.pathname])

  const navItems: readonly SidebarNavItem[] = [
    { to: '/', icon: BookOpen, label: t('nav.home') },
    { to: '/projects', icon: Folder, label: t('nav.projects') },
    { to: '/settings', icon: Settings, label: t('nav.settings') },
    { to: '/about', icon: BadgeInfo, label: t('nav.about') }
  ]

  if (mode === 'bottom') {
    return (
      <nav
        className="fixed inset-x-0 bottom-0 z-50 flex h-[calc(4.25rem+env(safe-area-inset-bottom))] items-stretch border-t border-sidebar-border/80 bg-sidebar/95 pt-2 text-sidebar-foreground shadow-[0_-8px_24px_rgb(0_0_0/0.06)] backdrop-blur-md pb-[env(safe-area-inset-bottom)] dark:shadow-[0_-8px_24px_rgb(0_0_0/0.28)]"
        aria-label="主导航"
      >
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
              className={cn(
                'mx-1 mb-1 flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[11px] transition-colors active:scale-[0.98]',
                isActive
                  ? 'bg-foreground/8 text-foreground'
                  : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
              )}
            >
              <Icon className="size-5" />
              <span className="max-w-full truncate font-medium">{label}</span>
            </NavLink>
          )
        })}
      </nav>
    )
  }

  if (mode === 'drawer') {
    return (
      <>
        <div className="fixed top-0 left-0 right-0 z-50 flex h-[calc(3rem+env(safe-area-inset-top))] items-center gap-2 border-b border-sidebar-border bg-sidebar px-3 pt-[env(safe-area-inset-top)] text-sidebar-foreground">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9"
            aria-label={drawerOpen ? '关闭菜单' : '打开菜单'}
            onClick={(): void => setDrawerOpen((open: boolean): boolean => !open)}
          >
            {drawerOpen ? <X className="size-4" /> : <Menu className="size-4" />}
          </Button>
          <img src={logo} draggable={false} alt="Logo" className="size-6 object-contain" />
          <span className="text-sm font-semibold">MySekaiStoryteller</span>
        </div>
        {drawerOpen ? (
          <button
            type="button"
            className="fixed inset-0 z-40 bg-black/40"
            aria-label="关闭菜单遮罩"
            onClick={(): void => setDrawerOpen(false)}
          />
        ) : null}
        <aside
          className={cn(
            'fixed top-12 bottom-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground shadow-lg transition-transform duration-200',
            drawerOpen ? 'translate-x-0' : '-translate-x-full'
          )}
        >
          <nav draggable={false} className="flex-1 space-y-2 p-3 select-none">
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
                  className={cn(
                    'relative flex w-full items-center rounded-md px-3 py-2.5 transition-colors duration-200',
                    isActive
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                      : 'text-sidebar-foreground hover:bg-sidebar-accent/40 hover:text-sidebar-accent-foreground'
                  )}
                >
                  <Icon className="mr-3 size-4" />
                  <span>{label}</span>
                </NavLink>
              )
            })}
          </nav>
        </aside>
        <div className="h-12" />
      </>
    )
  }

  return (
    <aside className="fixed top-0 left-0 z-50 flex h-full w-65 flex-col items-center border-r border-sidebar-border bg-sidebar py-4 text-sidebar-foreground shadow-sm transition-colors duration-300">
      <div className="mt-4 mb-5 flex select-none items-center">
        <img src={logo} draggable={false} alt="Logo" className="mr-2 h-7 w-7 object-contain" />
        <h1 className="text-lg font-bold">MySekaiStoryteller</h1>
      </div>
      <nav draggable={false} className="relative w-full flex-1 space-y-2 p-3 select-none">
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
              className={cn(
                'relative flex w-full items-center rounded-md px-3 py-2 transition-colors duration-200',
                isActive
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-foreground hover:bg-sidebar-accent/40 hover:text-sidebar-accent-foreground'
              )}
            >
              <Icon className="mr-3 h-4 w-4" />
              <span>{label}</span>
            </NavLink>
          )
        })}
      </nav>
    </aside>
  )
}
