import logo from '@renderer/assets/logo.png'
import { Button } from '@renderer/components/ui/Button'
import { BookOpen, Folder, Settings } from 'lucide-react'

export default function LeftSidebar() {
  return (
    <aside className="fixed top-0 left-0 h-full w-65 bg-[#FCFCFC] shadow-sm z-50 flex flex-col items-center py-4">
      <div className="flex items-center mb-5 select-none mt-4">
        <img src={logo} alt="Logo" className="w-7 h-7 object-contain pointer-events-none mr-2" />
        <h1 className="text-lg font-bold">MySekaiStoryteller</h1>
      </div>
      <div className="flex flex-col space-y-2 w-full px-2">
        <nav className="flex-1 p-3 space-y-2">
          <Button
            variant="ghost"
            className="w-full justify-start bg-sidebar-accent text-sidebar-accent-foreground"
          >
            <BookOpen className="w-4 h-4 mr-3" />
            主页
          </Button>
          <Button
            variant="ghost"
            className="w-full justify-start text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <Folder className="w-4 h-4 mr-3" />
            项目
          </Button>
          <Button
            variant="ghost"
            className="w-full justify-start text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <Settings className="w-4 h-4 mr-3" />
            设置
          </Button>
        </nav>
      </div>
    </aside>
  )
}
