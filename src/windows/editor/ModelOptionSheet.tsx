import type { ChangeEvent, JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Check, Search, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/Input'
import { cn } from '@/lib/style'
import { fuzzyMatchOptions } from '@/lib/fuzzyMatch'

/**
 * Searchable bottom sheet for picking a motion or facial on touch layouts. It is non-modal on
 * purpose: the stage frame above stays visible, and picking an option keeps the sheet open so
 * several options can be auditioned in a row.
 */
export function ModelOptionSheet({
  open,
  onOpenChange,
  title,
  options,
  value,
  noneLabel,
  onSelect
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  options: readonly string[]
  value: string
  noneLabel: string
  onSelect: (value: string) => void
}): JSX.Element {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          data-slot="model-option-sheet"
          aria-describedby={undefined}
          onOpenAutoFocus={(event: Event): void => event.preventDefault()}
          onInteractOutside={(event: Event): void => event.preventDefault()}
          className="fixed inset-x-0 bottom-0 z-50 flex h-[46dvh] flex-col rounded-t-2xl border-t bg-popover pb-[env(safe-area-inset-bottom)] text-popover-foreground shadow-lg data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom duration-200"
        >
          <SheetBody
            title={title}
            options={options}
            value={value}
            noneLabel={noneLabel}
            onSelect={onSelect}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

// Mounted only while the sheet is open, so the query resets and the list scrolls to the current
// value each time.
function SheetBody({
  title,
  options,
  value,
  noneLabel,
  onSelect
}: {
  title: string
  options: readonly string[]
  value: string
  noneLabel: string
  onSelect: (value: string) => void
}): JSX.Element {
  const { t } = useTranslation()
  const listRef = useRef<HTMLDivElement | null>(null)
  const [query, setQuery] = useState<string>('')
  const matches: readonly string[] = useMemo(
    (): readonly string[] => fuzzyMatchOptions(options, query, options.length),
    [options, query]
  )

  useEffect((): void => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'center' })
  }, [])

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-2">
        <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-sm font-semibold">
          {title}
        </DialogPrimitive.Title>
        <DialogPrimitive.Close
          aria-label={t('common.close')}
          className="-mr-2 flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <X className="size-4" />
        </DialogPrimitive.Close>
      </div>
      <div className="relative mx-3 shrink-0">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          inputMode="search"
          autoComplete="off"
          aria-label={t('editor.modelPreviewSearch')}
          placeholder={t('editor.modelPreviewSearch')}
          value={query}
          className="pl-9 text-sm"
          onChange={(event: ChangeEvent<HTMLInputElement>): void =>
            setQuery(event.currentTarget.value)
          }
        />
      </div>
      <div
        ref={listRef}
        role="listbox"
        aria-label={title}
        className="mt-2 min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2"
      >
        {query ? null : (
          <SheetOption
            label={noneLabel}
            selected={value === ''}
            onPick={(): void => onSelect('')}
          />
        )}
        {matches.length > 0 ? (
          matches.map(
            (option: string): JSX.Element => (
              <SheetOption
                key={option}
                label={option}
                mono
                selected={option === value}
                onPick={(): void => onSelect(option)}
              />
            )
          )
        ) : (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t('editor.modelPreviewNoMatch')}
          </p>
        )}
      </div>
    </>
  )
}

function SheetOption({
  label,
  selected,
  mono = false,
  onPick
}: {
  label: string
  selected: boolean
  mono?: boolean
  onPick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={cn(
        'flex h-11 w-full items-center gap-2 rounded-md px-3 text-left text-[13px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        mono && 'font-mono',
        selected ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'active:bg-accent'
      )}
      onClick={onPick}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected ? <Check className="size-4 shrink-0" /> : null}
    </button>
  )
}
