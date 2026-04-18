import type { JSX, ReactNode } from 'react'

export function SettingRow({
  title,
  description,
  children
}: {
  title: string
  description: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2 py-5 md:flex-row md:items-center md:justify-between">
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="md:pl-6">{children}</div>
    </div>
  )
}
