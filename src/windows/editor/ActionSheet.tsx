import type { JSX, ReactNode } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/Dialog'
import { cn } from '@/lib/style'

export type ActionSheetItem = {
  key: string
  icon: ReactNode
  label: string
  disabled?: boolean
  destructive?: boolean
  onSelect: () => void
}

/** Bottom sheet of actions for touch layouts. Groups are separated by a divider. */
export function ActionSheet({
  open,
  onOpenChange,
  title,
  description,
  groups
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  groups: readonly (readonly ActionSheetItem[])[]
}): JSX.Element {
  function run(item: ActionSheetItem): void {
    onOpenChange(false)
    item.onSelect()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="gap-1 p-3">
        <DialogTitle className="px-3 pt-1 text-sm">{title}</DialogTitle>
        <DialogDescription className={cn('px-3 text-xs', !description && 'sr-only')}>
          {description ?? title}
        </DialogDescription>
        {groups.map(
          (group: readonly ActionSheetItem[], index: number): JSX.Element => (
            <div key={index} className={cn(index > 0 && 'mt-1 border-t pt-1')}>
              {group.map(
                (item: ActionSheetItem): JSX.Element => (
                  <button
                    key={item.key}
                    type="button"
                    disabled={item.disabled}
                    className={cn(
                      'flex h-12 w-full items-center gap-3 rounded-md px-3 text-left text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:bg-accent disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
                      item.destructive && 'text-destructive'
                    )}
                    onClick={(): void => run(item)}
                  >
                    {item.icon}
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  </button>
                )
              )}
            </div>
          )
        )}
      </DialogContent>
    </Dialog>
  )
}
