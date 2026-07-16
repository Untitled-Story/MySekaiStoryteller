import type { ShortcutBinding, ShortcutSettings } from './types'

export const DEFAULT_SHORTCUTS: ShortcutSettings = {
  editor: {
    save: createShortcutBinding('s', true)
  },
  player: {
    reload: createShortcutBinding('r', true),
    enterFullscreen: createShortcutBinding('F11'),
    exitFullscreen: createShortcutBinding('Escape'),
    close: createShortcutBinding('w', true)
  }
}

export function defaultShortcutSettings(): ShortcutSettings {
  return {
    editor: {
      save: { ...DEFAULT_SHORTCUTS.editor.save }
    },
    player: {
      reload: { ...DEFAULT_SHORTCUTS.player.reload },
      enterFullscreen: { ...DEFAULT_SHORTCUTS.player.enterFullscreen },
      exitFullscreen: { ...DEFAULT_SHORTCUTS.player.exitFullscreen },
      close: { ...DEFAULT_SHORTCUTS.player.close }
    }
  }
}

export function normalizeShortcutSettings(value?: ShortcutSettings): ShortcutSettings {
  return {
    editor: {
      save: normalizeShortcutBinding(value?.editor?.save, DEFAULT_SHORTCUTS.editor.save)
    },
    player: {
      reload: normalizeShortcutBinding(value?.player?.reload, DEFAULT_SHORTCUTS.player.reload),
      enterFullscreen: normalizeShortcutBinding(
        value?.player?.enterFullscreen,
        DEFAULT_SHORTCUTS.player.enterFullscreen
      ),
      exitFullscreen: normalizeShortcutBinding(
        value?.player?.exitFullscreen,
        DEFAULT_SHORTCUTS.player.exitFullscreen
      ),
      close: normalizeShortcutBinding(value?.player?.close, DEFAULT_SHORTCUTS.player.close)
    }
  }
}

export function shortcutBindingFromEvent(event: KeyboardEvent): ShortcutBinding | null {
  if (isModifierKey(event.key)) return null

  return {
    key: normalizeShortcutKey(event.key),
    primary: false,
    control: event.ctrlKey,
    meta: event.metaKey,
    alt: event.altKey,
    shift: event.shiftKey
  }
}

export function matchesShortcut(event: KeyboardEvent, binding: ShortcutBinding): boolean {
  return (
    normalizeShortcutKey(event.key) === normalizeShortcutKey(binding.key) &&
    shortcutModifiersMatch(binding, event.ctrlKey, event.metaKey) &&
    event.altKey === binding.alt &&
    event.shiftKey === binding.shift
  )
}

export function shortcutBindingsConflict(left: ShortcutBinding, right: ShortcutBinding): boolean {
  if (
    normalizeShortcutKey(left.key) !== normalizeShortcutKey(right.key) ||
    left.alt !== right.alt ||
    left.shift !== right.shift
  ) {
    return false
  }

  return [
    [false, false],
    [true, false],
    [false, true],
    [true, true]
  ].some(
    ([control, meta]: readonly boolean[]): boolean =>
      shortcutModifiersMatch(left, control, meta) && shortcutModifiersMatch(right, control, meta)
  )
}

export function shortcutBindingsEqual(left: ShortcutBinding, right: ShortcutBinding): boolean {
  return (
    normalizeShortcutKey(left.key) === normalizeShortcutKey(right.key) &&
    left.primary === right.primary &&
    left.control === right.control &&
    left.meta === right.meta &&
    left.alt === right.alt &&
    left.shift === right.shift
  )
}

export function shortcutBindingLabels(binding: ShortcutBinding): readonly string[] {
  const labels: string[] = []
  if (binding.primary) labels.push('Ctrl / ⌘')
  if (binding.control) labels.push('Ctrl')
  if (binding.meta) labels.push('⌘')
  if (binding.alt) labels.push('Alt')
  if (binding.shift) labels.push('Shift')
  labels.push(formatShortcutKey(binding.key))
  return labels
}

function createShortcutBinding(key: string, primary: boolean = false): ShortcutBinding {
  return { key, primary, control: false, meta: false, alt: false, shift: false }
}

function normalizeShortcutBinding(
  value: ShortcutBinding | undefined,
  fallback: ShortcutBinding
): ShortcutBinding {
  if (!value || typeof value.key !== 'string' || value.key.length === 0) {
    return { ...fallback }
  }

  return {
    key: normalizeShortcutKey(value.key),
    primary: value.primary === true,
    control: value.control === true,
    meta: value.meta === true,
    alt: value.alt === true,
    shift: value.shift === true
  }
}

function normalizeShortcutKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key
}

function formatShortcutKey(key: string): string {
  if (key === ' ') return 'Space'
  if (key.length === 1) return key.toUpperCase()
  return key
}

function isModifierKey(key: string): boolean {
  return ['Alt', 'AltGraph', 'Control', 'Meta', 'Shift'].includes(key)
}

function shortcutModifiersMatch(
  binding: ShortcutBinding,
  control: boolean,
  meta: boolean
): boolean {
  if (!binding.primary) return control === binding.control && meta === binding.meta
  if (!control && !meta) return false
  if (binding.control && !control) return false
  if (binding.meta && !meta) return false
  return true
}
