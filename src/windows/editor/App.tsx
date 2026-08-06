import type { ChangeEvent, JSX } from 'react'
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { open as openFileDialog, save as saveFileDialog } from '@tauri-apps/plugin-dialog'
import {
  getCurrentWindow,
  type CloseRequestedEvent,
  type Window as TauriWindow
} from '@tauri-apps/api/window'
import {
  ArrowLeft,
  ChevronRight,
  CirclePlay,
  Clapperboard,
  FileJson,
  FileArchive,
  LoaderCircle,
  Package,
  Play,
  Redo2,
  Save,
  Undo2
} from 'lucide-react'
import { useIsLandscapeViewport, useViewportMode, type ViewportMode } from '@/hooks/useViewportMode'
import { closeEditorWindow } from '@/windows/api'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/AlertDialog'
import { Button } from '@/components/ui/Button'
import { Toast, type ToastVariant } from '@/components/ui/Toast'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { cn } from '@/lib/style'
import { isMobileRuntime } from '@/lib/platform'
import { describeError as describeLogError, logger } from '@/lib/logger'
import type {
  ImportedModelResult,
  ModelArchiveCandidate,
  ModelRegistry
} from '@/modelRegistry/schema'
import { getModelRegistry, importGlobalModel, inspectModelArchive } from '@/modelRegistry/api'
import {
  deleteProjectAsset,
  getProjectAssetReferences,
  getProjectAssets,
  getProjectMetadata,
  getProjectPath,
  importProjectAsset,
  registerProjectModel,
  renameProjectAsset,
  setProjectAssets
} from '@/project/api'
import type {
  BackgroundAsset,
  ModelAsset,
  ProjectAssetKind,
  ProjectAssetMutationResult,
  ProjectAssetReference,
  ProjectAssets,
  VoiceAsset
} from '@/project/assets'
import type { ProjectMetadata } from '@/project/metadata'
import { exportProjectArchive } from '@/project/archive'
import { getSettings } from '@/settings/api'
import { matchesShortcut, normalizeShortcutSettings } from '@/settings/shortcuts'
import type { AppSettings, ShortcutBinding } from '@/settings/types'
import { getProjectStory, setProjectStory } from '@/story/api'
import type { StoryData } from '@/story'
import { getDataPath } from '@/workspace/api'
import { openPlayerWindow } from '@/windows/api'
import { useWindowProjectName } from '@/windows/useWindowProjectName'
import {
  filterTreeNodes,
  flattenTreeNodes,
  formatNodePath,
  type EditorAssetSelection,
  type FlatTreeNode
} from './editorCatalog'
import { EditorAssetInspector, EditorInspector } from './EditorInspector'
import { EditorPreview, type EditorPreviewInput } from './EditorPreview'
import { EditorSidebar, type EditorSidebarTab } from './EditorSidebar'
import {
  createDocumentHistory,
  duplicateSnippetSubtree,
  editorHistoryReducer,
  findAssetReferences,
  findEditorNode,
  findEditorNodePath,
  insertNewSnippet,
  removeSnippetSubtree,
  repairLegacyAssetDefaults,
  renameAssetReferences,
  storiesEqual,
  type AddableSnippetType,
  type EditorStory
} from './editorDocument'
import { moveSnippetSubtree, type SnippetDropPlacement } from './editorTree'
import { localizeAssetKind } from './editorLocalization'
import { EditorProductTour } from '@/onboarding/EditorProductTour'
import { EDITOR_TOUR_VERSION, normalizeOnboardingSettings } from '@/onboarding/types'
import { useTranslation } from 'react-i18next'
import { i18n } from '@/i18n'

type LoadedEditorProject = {
  metadata: ProjectMetadata
  story: StoryData
  previewInput: EditorPreviewInput
}

type LoadState =
  | { status: 'idle' | 'loading'; error?: never }
  | { status: 'ready'; error?: never }
  | { status: 'error'; error: string }

type AssetDeletePrompt = {
  selection: EditorAssetSelection
  references: readonly ProjectAssetReference[]
}

type StorySaveStatus = 'saved' | 'dirty' | 'saving' | 'error'

type EditorNotice = {
  id: number
  message: string
  variant: ToastVariant
}

type PersistedStorySnapshot = {
  projectName: string
  story: EditorStory
}

type QueuedStorySave = {
  projectName: string
  fingerprint: string
  promise: Promise<boolean>
}

type PendingAssetWrite = {
  projectName: string
  assets: ProjectAssets
}

const EMPTY_ASSETS: ProjectAssets = {
  models: {},
  backgrounds: {},
  voices: {}
}

const INITIAL_STORY: EditorStory = createDocumentHistory({ version: 1, snippets: [] }).present
const STRUCTURE_AUTOSAVE_DELAY_MS: number = 200
const INPUT_AUTOSAVE_DELAY_MS: number = 800
const ASSET_AUTOSAVE_DELAY_MS: number = 650
const SAVE_RETRY_DELAY_MS: number = 600

export default function App({
  settings,
  onCompleteEditorTour,
  preferredProjectName = null,
  embedInShell = false
}: {
  settings: AppSettings | null
  onCompleteEditorTour: () => void
  preferredProjectName?: string | null
  embedInShell?: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const requestedProjectName = useWindowProjectName(preferredProjectName)
  const viewportMode: ViewportMode = useViewportMode()
  const landscapeViewport: boolean = useIsLandscapeViewport()
  const mobileLandscapeLayout: boolean = isMobileRuntime() && landscapeViewport
  const [mobileBottomTab, setMobileBottomTab] = useState<'outline' | 'properties'>('outline')

  const [history, dispatchHistory] = useReducer(
    editorHistoryReducer,
    createDocumentHistory(INITIAL_STORY)
  )
  const [activeProjectName, setActiveProjectName] = useState<string | null>(null)
  const [loadedProject, setLoadedProject] = useState<LoadedEditorProject | null>(null)
  const [loadState, setLoadState] = useState<LoadState>({ status: 'idle' })
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [activePanel, setActivePanel] = useState<EditorSidebarTab>('story')
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [dragMode, setDragMode] = useState<boolean>(false)
  const [expandedParallelIds, setExpandedParallelIds] = useState<ReadonlySet<string>>(
    (): ReadonlySet<string> => new Set()
  )
  const [selectedAsset, setSelectedAsset] = useState<EditorAssetSelection | null>(null)
  const [addDialogOpen, setAddDialogOpen] = useState<boolean>(false)
  const [deleteSnippetId, setDeleteSnippetId] = useState<string | null>(null)
  const [assetDeletePrompt, setAssetDeletePrompt] = useState<AssetDeletePrompt | null>(null)
  const [pendingProjectName, setPendingProjectName] = useState<string | null>(null)
  const [projectSwitchNeedsDecision, setProjectSwitchNeedsDecision] = useState<boolean>(false)
  const [previewRequest, setPreviewRequest] = useState<number>(0)
  const [previewTargetNodeId, setPreviewTargetNodeId] = useState<string | null>(null)
  const [pauseAfterPreviewTarget, setPauseAfterPreviewTarget] = useState<boolean>(false)
  const [activeSnippetIds, setActiveSnippetIds] = useState<ReadonlySet<string>>(
    (): ReadonlySet<string> => new Set()
  )
  const [savingStory, setSavingStory] = useState<boolean>(false)
  const [savingAssets, setSavingAssets] = useState<boolean>(false)
  const [storySaveStatus, setStorySaveStatus] = useState<StorySaveStatus>('saved')
  const [storySaveError, setStorySaveError] = useState<string | null>(null)
  const [projectMutationInProgress, setProjectMutationInProgress] = useState<boolean>(false)
  const [exportingProject, setExportingProject] = useState<boolean>(false)
  const [editorNotice, setEditorNotice] = useState<EditorNotice | null>(null)
  const [registerModelOpen, setRegisterModelOpen] = useState<boolean>(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const inputMergeTimerRef = useRef<number | null>(null)
  const storySaveTimerRef = useRef<number | null>(null)
  const assetWriteTimerRef = useRef<number | null>(null)
  const blockedSwitchProjectRef = useRef<string | null>(null)
  const projectSwitchAttemptRef = useRef<string | null>(null)
  const projectMutationCountRef = useRef<number>(0)
  const assetsRef = useRef<ProjectAssets>(EMPTY_ASSETS)
  const storyRef = useRef<EditorStory>(INITIAL_STORY)
  const loadedProjectRef = useRef<LoadedEditorProject | null>(null)
  const projectWriteQueueRef = useRef<Promise<void>>(Promise.resolve())
  const queuedStorySaveRef = useRef<QueuedStorySave | null>(null)
  const queuedAssetWriteRef = useRef<Promise<boolean> | null>(null)
  const pendingAssetWriteRef = useRef<PendingAssetWrite | null>(null)
  const lastPersistedStoryRef = useRef<PersistedStorySnapshot | null>(null)
  const saveSessionRef = useRef<number>(0)
  const allowWindowCloseRef = useRef<boolean>(false)
  const beginStorySaveSessionRef = useRef<(projectName: string, savedStory: EditorStory) => void>(
    (): void => undefined
  )
  const enqueueStorySaveRef = useRef<
    (projectName: string, snapshot: EditorStory) => Promise<boolean>
  >((): Promise<boolean> => Promise.resolve(false))
  const flushEditorWritesRef = useRef<() => Promise<boolean>>(
    (): Promise<boolean> => Promise.resolve(true)
  )

  const story: EditorStory = history.present
  storyRef.current = story
  loadedProjectRef.current = loadedProject
  const isDirty: boolean = !storiesEqual(history.present, history.saved)
  const editorSaving: boolean = savingStory || savingAssets || projectMutationInProgress
  const saveButtonTitle: string = editorSaving
    ? t('editor.saving')
    : storySaveStatus === 'error'
      ? t('editor.saveFailedRetry')
      : isDirty
        ? t('editor.saveNow')
        : t('editor.saved')
  const visibleError: string | null = storySaveError ?? actionError
  const loadedProjectName: string | null = loadedProject?.previewInput.projectName ?? null
  const selectedNode = findEditorNode(story, selectedNodeId)
  const previewTargetNode: ReturnType<typeof findEditorNode> = findEditorNode(
    story,
    previewTargetNodeId
  )
  const selectedNodePath = findEditorNodePath(story, selectedNodeId)
  const displayedNodePath: string = formatNodePath(selectedNodePath ?? [])
  const deleteSnippetNode = findEditorNode(story, deleteSnippetId)
  const treeNodes: readonly FlatTreeNode[] = useMemo(
    (): readonly FlatTreeNode[] =>
      filterTreeNodes(flattenTreeNodes(story, expandedParallelIds), searchQuery),
    [expandedParallelIds, searchQuery, story]
  )
  const previewInput: EditorPreviewInput | null = useMemo(
    (): EditorPreviewInput | null => loadedProject?.previewInput ?? null,
    [loadedProject?.previewInput]
  )
  const saveShortcut: ShortcutBinding = useMemo(
    (): ShortcutBinding => normalizeShortcutSettings(settings?.shortcuts).editor.save,
    [settings?.shortcuts]
  )

  useEffect((): void => {
    assetsRef.current = loadedProject?.previewInput.assets ?? EMPTY_ASSETS
  }, [loadedProject])

  useEffect((): (() => void) => {
    return (): void => {
      if (inputMergeTimerRef.current !== null) {
        window.clearTimeout(inputMergeTimerRef.current)
      }
      clearStorySaveTimer()
      clearAssetWriteTimer()
      saveSessionRef.current += 1
    }
  }, [])

  useEffect((): (() => void) => {
    function saveOnShortcut(event: KeyboardEvent): void {
      if (!matchesShortcut(event, saveShortcut)) return
      event.preventDefault()
      void flushEditorWritesRef.current()
    }

    window.addEventListener('keydown', saveOnShortcut, true)
    return (): void => window.removeEventListener('keydown', saveOnShortcut, true)
  }, [saveShortcut])

  useEffect((): (() => void) | undefined => {
    if (embedInShell) return undefined

    const currentWindow: TauriWindow = getCurrentWindow()
    let unlisten: (() => void) | null = null
    let disposed: boolean = false

    void currentWindow
      .onCloseRequested(async (event: CloseRequestedEvent): Promise<void> => {
        if (allowWindowCloseRef.current || !loadedProjectRef.current) return

        event.preventDefault()
        const saved: boolean = await flushEditorWritesRef.current()
        if (!saved) return

        allowWindowCloseRef.current = true
        try {
          await currentWindow.destroy()
        } catch (error: unknown) {
          allowWindowCloseRef.current = false
          setActionError(describeError(error, t('editor.closeEditorFailed')))
          logger.error('editor.window_close_failed', {
            error: describeLogError(error)
          })
        }
      })
      .then((listener: () => void): void => {
        if (disposed) listener()
        else unlisten = listener
      })

    return (): void => {
      disposed = true
      unlisten?.()
    }
  }, [embedInShell, t])

  useEffect((): void => {
    if (!requestedProjectName || requestedProjectName === activeProjectName) return
    if (
      blockedSwitchProjectRef.current &&
      blockedSwitchProjectRef.current !== requestedProjectName
    ) {
      blockedSwitchProjectRef.current = null
    }
    if (blockedSwitchProjectRef.current === requestedProjectName) return

    if (activeProjectName && loadedProject) {
      if (projectSwitchAttemptRef.current === requestedProjectName) return
      projectSwitchAttemptRef.current = requestedProjectName
      setPendingProjectName(requestedProjectName)
      setProjectSwitchNeedsDecision(false)
      void flushEditorWritesRef.current().then((saved: boolean): void => {
        if (projectSwitchAttemptRef.current !== requestedProjectName) return
        if (!saved) {
          setProjectSwitchNeedsDecision(true)
          return
        }
        projectSwitchAttemptRef.current = null
        setPendingProjectName(null)
        setActiveProjectName(requestedProjectName)
      })
      return
    }

    setActiveProjectName(requestedProjectName)
  }, [activeProjectName, loadedProject, requestedProjectName])

  useEffect((): (() => void) | undefined => {
    if (!activeProjectName) return undefined

    let cancelled = false
    const startedAt: number = performance.now()
    setLoadState({ status: 'loading' })
    setLoadedProject(null)
    setActionError(null)
    logger.info('editor.project_load_started', { projectName: activeProjectName })

    void loadEditorProject(activeProjectName)
      .then((project: LoadedEditorProject): void => {
        if (cancelled) return
        const nextHistory = createDocumentHistory(project.story)
        beginStorySaveSessionRef.current(project.previewInput.projectName, nextHistory.present)
        dispatchHistory({ type: 'load', story: nextHistory.present })
        setLoadedProject(project)
        setSelectedNodeId(nextHistory.present.snippets[0]?.id ?? null)
        setActiveSnippetIds(new Set())
        setPreviewTargetNodeId(null)
        setPauseAfterPreviewTarget(false)
        setSelectedAsset(firstAssetSelection(project.previewInput.assets))
        setExpandedParallelIds(collectParallelIds(nextHistory.present))
        setSearchQuery('')
        setActivePanel('story')
        setStorySaveError(null)
        setLoadState({ status: 'ready' })
        logger.info('editor.project_load_completed', {
          projectName: activeProjectName,
          durationMs: Math.round(performance.now() - startedAt),
          snippetCount: nextHistory.present.snippets.length,
          modelCount: Object.keys(project.previewInput.assets.models).length,
          backgroundCount: Object.keys(project.previewInput.assets.backgrounds).length,
          voiceCount: Object.keys(project.previewInput.assets.voices).length
        })
      })
      .catch((error: unknown): void => {
        if (cancelled) return
        logger.error('editor.project_load_failed', {
          projectName: activeProjectName,
          durationMs: Math.round(performance.now() - startedAt),
          error: describeLogError(error)
        })
        setLoadState({
          status: 'error',
          error: describeError(error, t('editor.loadProjectFailed'))
        })
      })

    return (): void => {
      cancelled = true
    }
  }, [activeProjectName, t])

  useEffect((): void => {
    if (selectedNodeId && !selectedNode) {
      setSelectedNodeId(story.snippets[0]?.id ?? null)
    }
  }, [selectedNode, selectedNodeId, story.snippets])

  useEffect((): void => {
    if (previewTargetNodeId && !previewTargetNode) {
      setPreviewTargetNodeId(null)
    }
  }, [previewTargetNode, previewTargetNodeId])

  useEffect((): void => {
    if (!loadedProject) return
    const repairedStory: EditorStory = repairLegacyAssetDefaults(
      story,
      loadedProject.previewInput.assets
    )
    if (!storiesEqual(story, repairedStory)) {
      dispatchHistory({ type: 'commit', story: repairedStory })
    }
  }, [loadedProject, story])

  useEffect((): (() => void) | undefined => {
    if (!loadedProjectName) return undefined

    clearStorySaveTimer()
    const projectName: string = loadedProjectName
    const fingerprint: string = storyFingerprint(story)
    const queuedSave: QueuedStorySave | null = queuedStorySaveRef.current
    const hasDifferentQueuedSave: boolean = Boolean(
      queuedSave && queuedSave.projectName === projectName && queuedSave.fingerprint !== fingerprint
    )

    if (!isDirty && !hasDifferentQueuedSave) {
      setStorySaveStatus('saved')
      return undefined
    }

    setStorySaveStatus(
      (current: StorySaveStatus): StorySaveStatus => (current === 'saving' ? current : 'dirty')
    )
    const delayMs: number = history.activeMergeKey
      ? INPUT_AUTOSAVE_DELAY_MS
      : STRUCTURE_AUTOSAVE_DELAY_MS
    storySaveTimerRef.current = window.setTimeout((): void => {
      storySaveTimerRef.current = null
      void enqueueStorySaveRef.current(projectName, story)
    }, delayMs)

    return (): void => clearStorySaveTimer()
  }, [history.activeMergeKey, isDirty, loadedProjectName, story])

  function clearStorySaveTimer(): void {
    if (storySaveTimerRef.current === null) return
    window.clearTimeout(storySaveTimerRef.current)
    storySaveTimerRef.current = null
  }

  function clearAssetWriteTimer(): void {
    if (assetWriteTimerRef.current === null) return
    window.clearTimeout(assetWriteTimerRef.current)
    assetWriteTimerRef.current = null
  }

  function beginStorySaveSession(projectName: string, savedStory: EditorStory): void {
    clearStorySaveTimer()
    clearAssetWriteTimer()
    saveSessionRef.current += 1
    queuedStorySaveRef.current = null
    queuedAssetWriteRef.current = null
    pendingAssetWriteRef.current = null
    lastPersistedStoryRef.current = { projectName, story: savedStory }
    setSavingStory(false)
    setSavingAssets(false)
    setStorySaveStatus('saved')
  }

  function invalidateSaveSession(): void {
    clearStorySaveTimer()
    clearAssetWriteTimer()
    saveSessionRef.current += 1
    queuedStorySaveRef.current = null
    queuedAssetWriteRef.current = null
    pendingAssetWriteRef.current = null
    setSavingStory(false)
    setSavingAssets(false)
  }

  function enqueueStorySave(projectName: string, snapshot: EditorStory): Promise<boolean> {
    const fingerprint: string = storyFingerprint(snapshot)
    const queuedSave: QueuedStorySave | null = queuedStorySaveRef.current
    if (
      queuedSave &&
      queuedSave.projectName === projectName &&
      queuedSave.fingerprint === fingerprint
    ) {
      return queuedSave.promise
    }

    const persisted: PersistedStorySnapshot | null = lastPersistedStoryRef.current
    if (
      !queuedSave &&
      persisted?.projectName === projectName &&
      storiesEqual(persisted.story, snapshot)
    ) {
      return Promise.resolve(true)
    }

    const session: number = saveSessionRef.current
    const startedAt: number = performance.now()
    const task: Promise<boolean> = projectWriteQueueRef.current.then(async (): Promise<boolean> => {
      if (session !== saveSessionRef.current) return false

      setSavingStory(true)
      setStorySaveStatus('saving')
      setStorySaveError(null)
      logger.info('editor.story_save_started', {
        projectName,
        snapshotBytes: fingerprint.length
      })

      try {
        await saveStoryWithRetry(projectName, snapshot)
        if (session !== saveSessionRef.current) return false

        lastPersistedStoryRef.current = { projectName, story: snapshot }
        dispatchHistory({ type: 'save', story: snapshot })
        const latestMatches: boolean = storiesEqual(storyRef.current, snapshot)
        setStorySaveStatus(latestMatches ? 'saved' : 'dirty')
        logger.info('editor.story_save_completed', {
          projectName,
          snapshotBytes: fingerprint.length,
          durationMs: Math.round(performance.now() - startedAt),
          latestMatches
        })
        return true
      } catch (error: unknown) {
        if (session !== saveSessionRef.current) return false
        const message: string = describeError(error, t('editor.saveStoryFailed'))
        setStorySaveStatus('error')
        setStorySaveError(message)
        logger.error('editor.story_save_failed', {
          projectName,
          snapshotBytes: fingerprint.length,
          durationMs: Math.round(performance.now() - startedAt),
          error: describeLogError(error)
        })
        return false
      } finally {
        if (session === saveSessionRef.current) setSavingStory(false)
      }
    })

    projectWriteQueueRef.current = task.then((): void => undefined)
    queuedStorySaveRef.current = { projectName, fingerprint, promise: task }
    void task.then((): void => {
      if (queuedStorySaveRef.current?.promise === task) queuedStorySaveRef.current = null
    })
    return task
  }

  async function saveStoryWithRetry(projectName: string, snapshot: EditorStory): Promise<void> {
    try {
      await setProjectStory(projectName, snapshot)
    } catch (error: unknown) {
      logger.warn('editor.story_save_retry', {
        projectName,
        error: describeLogError(error)
      })
      await waitForDelay(SAVE_RETRY_DELAY_MS)
      await setProjectStory(projectName, snapshot)
    }
  }

  function scheduleAssetWrite(projectName: string, assets: ProjectAssets): void {
    pendingAssetWriteRef.current = { projectName, assets }
    clearAssetWriteTimer()
    assetWriteTimerRef.current = window.setTimeout((): void => {
      assetWriteTimerRef.current = null
      void flushAssetWrites()
    }, ASSET_AUTOSAVE_DELAY_MS)
  }

  function enqueueAssetWrite(write: PendingAssetWrite): Promise<boolean> {
    const session: number = saveSessionRef.current
    const task: Promise<boolean> = projectWriteQueueRef.current.then(async (): Promise<boolean> => {
      if (session !== saveSessionRef.current) return false

      setSavingAssets(true)
      try {
        await saveAssetsWithRetry(write.projectName, write.assets)
        if (session !== saveSessionRef.current) return false
        setActionError(null)
        return true
      } catch (error: unknown) {
        if (session !== saveSessionRef.current) return false
        if (!pendingAssetWriteRef.current) pendingAssetWriteRef.current = write
        setActionError(describeError(error, t('editor.saveAssetsFailed')))
        logger.error('editor.assets_save_failed', {
          projectName: write.projectName,
          error: describeLogError(error)
        })
        return false
      } finally {
        if (session === saveSessionRef.current) setSavingAssets(false)
      }
    })

    projectWriteQueueRef.current = task.then((): void => undefined)
    queuedAssetWriteRef.current = task
    void task.then((): void => {
      if (queuedAssetWriteRef.current === task) queuedAssetWriteRef.current = null
    })
    return task
  }

  async function saveAssetsWithRetry(projectName: string, assets: ProjectAssets): Promise<void> {
    try {
      await setProjectAssets(projectName, assets)
    } catch (error: unknown) {
      logger.warn('editor.assets_save_retry', {
        projectName,
        error: describeLogError(error)
      })
      await waitForDelay(SAVE_RETRY_DELAY_MS)
      await setProjectAssets(projectName, assets)
    }
  }

  async function flushAssetWrites(): Promise<boolean> {
    clearAssetWriteTimer()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const pendingWrite: PendingAssetWrite | null = pendingAssetWriteRef.current
      if (pendingWrite) pendingAssetWriteRef.current = null
      const task: Promise<boolean> | null = pendingWrite
        ? enqueueAssetWrite(pendingWrite)
        : queuedAssetWriteRef.current
      if (!task) return true

      const saved: boolean = await task
      if (!saved) return false
      if (!pendingAssetWriteRef.current) return true
    }
    setActionError(t('editor.assetsChanging'))
    return false
  }

  function commitStory(nextStory: EditorStory, mergeKey?: string): void {
    dispatchHistory({ type: 'commit', story: nextStory, mergeKey })
    if (!mergeKey) return
    if (inputMergeTimerRef.current !== null) window.clearTimeout(inputMergeTimerRef.current)
    inputMergeTimerRef.current = window.setTimeout((): void => {
      dispatchHistory({ type: 'flush-merge' })
      inputMergeTimerRef.current = null
    }, 550)
  }

  function requestPreview(targetNodeId: string | null, pauseAfterTarget: boolean): void {
    setActiveSnippetIds(new Set())
    setPreviewTargetNodeId(targetNodeId)
    setPauseAfterPreviewTarget(pauseAfterTarget)
    setPreviewRequest((current: number): number => current + 1)
  }

  async function playSavedProject(): Promise<void> {
    if (!loadedProject) return
    setActionError(null)
    try {
      const saved: boolean = await flushEditorWrites()
      if (!saved) return
      await openPlayerWindow(loadedProject.previewInput.projectName)
    } catch (error: unknown) {
      setActionError(describeError(error, t('editor.openPlayerFailed')))
    }
  }

  async function exportCurrentProject(): Promise<void> {
    if (!loadedProject || exportingProject) return
    const projectName: string = loadedProject.previewInput.projectName
    const destination = await saveFileDialog({
      title: t('projectArchive.chooseExport'),
      defaultPath: `${loadedProject.metadata.title}.sest`,
      filters: [{ name: t('projectArchive.fileType'), extensions: ['sest'] }]
    })
    if (!destination) return

    setExportingProject(true)
    setActionError(null)
    try {
      const saved: boolean = await flushEditorWrites()
      if (!saved) return
      await runProjectMutation(
        async (): Promise<void> => exportProjectArchive(projectName, destination)
      )
      setEditorNotice({
        id: Date.now(),
        message: t('projectArchive.exportComplete'),
        variant: 'success'
      })
    } catch (error: unknown) {
      setEditorNotice({
        id: Date.now(),
        message: t('projectArchive.exportFailed', {
          error: error instanceof Error ? error.message : String(error)
        }),
        variant: 'error'
      })
    } finally {
      setExportingProject(false)
    }
  }

  function flushInputMerge(): void {
    if (inputMergeTimerRef.current !== null) {
      window.clearTimeout(inputMergeTimerRef.current)
      inputMergeTimerRef.current = null
    }
    dispatchHistory({ type: 'flush-merge' })
  }

  async function saveStory(): Promise<boolean> {
    if (!loadedProject) return false
    flushInputMerge()
    clearStorySaveTimer()
    const projectName: string = loadedProject.previewInput.projectName
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const snapshot: EditorStory = storyRef.current
      const saved: boolean = await enqueueStorySave(projectName, snapshot)
      if (!saved) return false

      const latestStory: EditorStory = storyRef.current
      const queuedSave: QueuedStorySave | null = queuedStorySaveRef.current
      const queuedDifferentSnapshot: boolean = Boolean(
        queuedSave &&
          queuedSave.projectName === projectName &&
          queuedSave.fingerprint !== storyFingerprint(latestStory)
      )
      const persisted: PersistedStorySnapshot | null = lastPersistedStoryRef.current
      if (
        !queuedDifferentSnapshot &&
        persisted?.projectName === projectName &&
        storiesEqual(persisted.story, latestStory)
      ) {
        return true
      }
    }

    setStorySaveStatus('error')
    setStorySaveError(t('editor.storyChanging'))
    return false
  }

  async function flushEditorWrites(): Promise<boolean> {
    const storySaved: boolean = await saveStory()
    const assetsSaved: boolean = await flushAssetWrites()
    await projectWriteQueueRef.current
    return storySaved && assetsSaved
  }

  function runProjectMutation<TResult>(mutation: () => Promise<TResult>): Promise<TResult> {
    function finishProjectMutation(): void {
      projectMutationCountRef.current = Math.max(0, projectMutationCountRef.current - 1)
      setProjectMutationInProgress(projectMutationCountRef.current > 0)
    }

    projectMutationCountRef.current += 1
    setProjectMutationInProgress(true)
    const task: Promise<TResult> = projectWriteQueueRef.current.then(mutation)
    projectWriteQueueRef.current = task.then(
      (): void => undefined,
      (): void => undefined
    )
    void task.then(
      (): void => finishProjectMutation(),
      (): void => finishProjectMutation()
    )
    return task
  }

  beginStorySaveSessionRef.current = beginStorySaveSession
  enqueueStorySaveRef.current = enqueueStorySave
  flushEditorWritesRef.current = flushEditorWrites

  function addSnippet(type: AddableSnippetType): void {
    try {
      const insertion = insertNewSnippet(
        story,
        type,
        selectedNode?.id ?? null,
        previewInput?.assets ?? EMPTY_ASSETS
      )
      commitStory(insertion.story)
      setSelectedNodeId(insertion.insertedId)
      setActivePanel('story')
      setAddDialogOpen(false)
    } catch (error: unknown) {
      setActionError(describeError(error, t('editor.addSnippetFailed')))
    }
  }

  function duplicateSnippet(nodeId: string): void {
    const duplication = duplicateSnippetSubtree(story, nodeId)
    if (!duplication) return
    commitStory(duplication.story)
    setSelectedNodeId(duplication.duplicatedId)
  }

  function duplicateSelectedSnippet(): void {
    if (selectedNode) duplicateSnippet(selectedNode.id)
  }

  function deleteSelectedSnippet(): void {
    if (!deleteSnippetNode) return
    const nextStory = removeSnippetSubtree(story, deleteSnippetNode.id)
    commitStory(nextStory)
    setSelectedNodeId(nextStory.snippets[0]?.id ?? null)
    setDeleteSnippetId(null)
  }

  function moveSnippet(sourceId: string, targetId: string, placement: SnippetDropPlacement): void {
    const nextStory: EditorStory | null = moveSnippetSubtree(story, sourceId, targetId, placement)
    if (!nextStory) return

    commitStory(nextStory)
    setSelectedNodeId(sourceId)
    requestPreview(sourceId, true)
    if (placement === 'inside') {
      setExpandedParallelIds((current: ReadonlySet<string>): ReadonlySet<string> => {
        const next: Set<string> = new Set(current)
        next.add(targetId)
        return next
      })
    }
  }

  function toggleParallel(nodeId: string): void {
    setExpandedParallelIds((current: ReadonlySet<string>): ReadonlySet<string> => {
      const next: Set<string> = new Set(current)
      if (next.has(nodeId)) {
        next.delete(nodeId)
      } else {
        next.add(nodeId)
      }
      return next
    })
  }

  async function importAsset(kind: Exclude<ProjectAssetKind, 'models'>): Promise<void> {
    if (!loadedProject) return
    const extensions: readonly string[] =
      kind === 'backgrounds' ? ['png', 'jpg', 'jpeg', 'webp'] : ['ogg', 'mp3', 'wav', 'm4a']
    const sourcePath = await openFileDialog({
      multiple: false,
      title: t('editor.importAssetTitle', { kind: localizeAssetKind(kind) }),
      filters: [{ name: localizeAssetKind(kind), extensions: [...extensions] }]
    })
    if (!sourcePath || Array.isArray(sourcePath)) return

    setActionError(null)
    try {
      const saved: boolean = await flushEditorWrites()
      if (!saved) return
      await runProjectMutation(async (): Promise<void> => {
        const result: ProjectAssetMutationResult = await importProjectAsset(
          loadedProject.previewInput.projectName,
          kind,
          sourcePath
        )
        replaceAssets(result.assets)
        setSelectedAsset({ kind, key: result.key })
        setActivePanel('assets')
      })
    } catch (error: unknown) {
      const message: string = describeError(
        error,
        t('editor.importAssetFailed', { kind: localizeAssetKind(kind) })
      )
      setActionError(message)
      setEditorNotice({ id: Date.now(), message, variant: 'error' })
    }
  }

  function replaceAssets(nextAssets: ProjectAssets): void {
    assetsRef.current = nextAssets
    setLoadedProject((current: LoadedEditorProject | null): LoadedEditorProject | null =>
      current
        ? {
            ...current,
            previewInput: {
              ...current.previewInput,
              assets: nextAssets
            }
          }
        : current
    )
  }

  function replaceModelRegistry(modelRegistry: ModelRegistry): void {
    setLoadedProject((current: LoadedEditorProject | null): LoadedEditorProject | null =>
      current
        ? {
            ...current,
            previewInput: {
              ...current.previewInput,
              modelRegistry
            }
          }
        : current
    )
  }

  function updateAssets(update: (assets: ProjectAssets) => ProjectAssets): void {
    if (!loadedProject) return
    const nextAssets: ProjectAssets = update(assetsRef.current)
    const projectName: string = loadedProject.previewInput.projectName
    replaceAssets(nextAssets)
    scheduleAssetWrite(projectName, nextAssets)
  }

  function updateModelAsset(key: string, asset: ModelAsset): void {
    updateAssets(
      (assets: ProjectAssets): ProjectAssets => ({
        ...assets,
        models: { ...assets.models, [key]: asset }
      })
    )
  }

  function updateFileAsset(
    kind: Exclude<ProjectAssetKind, 'models'>,
    key: string,
    asset: BackgroundAsset | VoiceAsset
  ): void {
    if (kind === 'backgrounds') {
      updateAssets(
        (assets: ProjectAssets): ProjectAssets => ({
          ...assets,
          backgrounds: { ...assets.backgrounds, [key]: asset as BackgroundAsset }
        })
      )
      return
    }
    updateAssets(
      (assets: ProjectAssets): ProjectAssets => ({
        ...assets,
        voices: { ...assets.voices, [key]: asset as VoiceAsset }
      })
    )
  }

  async function renameAsset(selection: EditorAssetSelection, nextKey: string): Promise<void> {
    if (!loadedProject) return
    const saved: boolean = await flushEditorWrites()
    if (!saved) return
    const persistedBeforeRename: EditorStory =
      lastPersistedStoryRef.current?.story ?? storyRef.current
    try {
      await runProjectMutation(async (): Promise<void> => {
        const nextAssets: ProjectAssets = await renameProjectAsset(
          loadedProject.previewInput.projectName,
          selection.kind,
          selection.key,
          nextKey
        )
        replaceAssets(nextAssets)
        const persistedRewrittenStory: EditorStory = renameAssetReferences(
          persistedBeforeRename,
          selection.kind,
          selection.key,
          nextKey
        )
        const currentRewrittenStory: EditorStory = renameAssetReferences(
          storyRef.current,
          selection.kind,
          selection.key,
          nextKey
        )
        beginStorySaveSession(loadedProject.previewInput.projectName, persistedRewrittenStory)
        dispatchHistory({ type: 'load', story: persistedRewrittenStory })
        if (!storiesEqual(currentRewrittenStory, persistedRewrittenStory)) {
          dispatchHistory({ type: 'commit', story: currentRewrittenStory })
        }
        setSelectedAsset({ kind: selection.kind, key: nextKey })
      })
    } catch (error: unknown) {
      setActionError(describeError(error, t('editor.renameAssetFailed')))
    }
  }

  async function requestDeleteAsset(selection: EditorAssetSelection): Promise<void> {
    if (!loadedProject) return
    const inMemoryReferences = findAssetReferences(story, selection.kind, selection.key)
    if (inMemoryReferences.length > 0) {
      setAssetDeletePrompt({
        selection,
        references: inMemoryReferences.map(
          (reference): ProjectAssetReference => ({
            snippetId: reference.snippetId,
            snippetType: reference.snippetType,
            path: t('editor.memoryStoryReference', { id: reference.snippetId.slice(0, 8) })
          })
        )
      })
      return
    }
    try {
      const saved: boolean = await flushEditorWrites()
      if (!saved) return
      const references = await getProjectAssetReferences(
        loadedProject.previewInput.projectName,
        selection.kind,
        selection.key
      )
      setAssetDeletePrompt({ selection, references })
    } catch (error: unknown) {
      setActionError(describeError(error, t('editor.inspectReferencesFailed')))
    }
  }

  async function confirmDeleteAsset(): Promise<void> {
    if (!loadedProject || !assetDeletePrompt || assetDeletePrompt.references.length > 0) return
    try {
      const saved: boolean = await flushEditorWrites()
      if (!saved) return
      await runProjectMutation(async (): Promise<void> => {
        const nextAssets: ProjectAssets = await deleteProjectAsset(
          loadedProject.previewInput.projectName,
          assetDeletePrompt.selection.kind,
          assetDeletePrompt.selection.key
        )
        replaceAssets(nextAssets)
        setSelectedAsset(firstAssetSelection(nextAssets))
        setAssetDeletePrompt(null)
      })
    } catch (error: unknown) {
      setActionError(describeError(error, t('editor.deleteAssetFailed')))
      setAssetDeletePrompt(null)
    }
  }

  async function handleProjectSwitch(action: 'save' | 'discard' | 'cancel'): Promise<void> {
    const targetProjectName: string | null = pendingProjectName
    if (!targetProjectName) return
    if (action === 'save') {
      setProjectSwitchNeedsDecision(false)
      const saved: boolean = await flushEditorWrites()
      if (!saved) {
        setProjectSwitchNeedsDecision(true)
        return
      }
    }
    if (action === 'cancel') {
      blockedSwitchProjectRef.current = targetProjectName
      projectSwitchAttemptRef.current = null
      setPendingProjectName(null)
      setProjectSwitchNeedsDecision(false)
      return
    }
    if (action === 'discard') invalidateSaveSession()
    blockedSwitchProjectRef.current = null
    projectSwitchAttemptRef.current = null
    setPendingProjectName(null)
    setProjectSwitchNeedsDecision(false)
    setActiveProjectName(targetProjectName)
  }

  function retryLoad(): void {
    if (!activeProjectName) return
    setActiveProjectName(null)
    window.setTimeout((): void => setActiveProjectName(activeProjectName), 0)
  }

  if (!requestedProjectName && !activeProjectName) {
    return <EditorStateMessage title={t('editor.noProject')} detail={t('editor.openProjectHint')} />
  }

  if (loadState.status === 'error') {
    return (
      <EditorStateMessage
        title={t('editor.projectLoadFailed')}
        detail={loadState.error}
        onRetry={retryLoad}
      />
    )
  }

  if (loadState.status === 'loading' || !loadedProject || !previewInput) {
    return (
      <EditorStateMessage
        title={t('editor.loadingProject')}
        detail={t('editor.readingProject')}
        loading
      />
    )
  }

  const phoneLayout: boolean = viewportMode === 'phone' && !mobileLandscapeLayout
  const tabletLayout: boolean = viewportMode === 'tablet' && !mobileLandscapeLayout
  const compactChrome: boolean = phoneLayout || tabletLayout || mobileLandscapeLayout

  const touchMode: boolean = settings?.interaction.touchMode ?? false
  const sidebarNode: JSX.Element = (
    <EditorSidebar
      activePanel={activePanel}
      searchQuery={searchQuery}
      touchMode={touchMode}
      dragMode={dragMode}
      onDragModeChange={setDragMode}
      treeNodes={treeNodes}
      selectedNodeId={selectedNode?.id ?? null}
      activeSnippetIds={activeSnippetIds}
      expandedParallelIds={expandedParallelIds}
      assets={previewInput.assets}
      selectedAsset={selectedAsset}
      addDialogOpen={addDialogOpen}
      onActivePanelChange={setActivePanel}
      onSearchQueryChange={setSearchQuery}
      onSelectNode={(nodeId: string): void => {
        setSelectedNodeId(nodeId)
        setActivePanel('story')
        if (phoneLayout && !dragMode) setMobileBottomTab('properties')
        requestPreview(nodeId, true)
      }}
      onContextSelectSnippet={(nodeId: string): void => {
        setSelectedNodeId(nodeId)
        setActivePanel('story')
        if (phoneLayout && !dragMode) setMobileBottomTab('properties')
      }}
      onPreviewSnippet={(nodeId: string): void => {
        setSelectedNodeId(nodeId)
        setActivePanel('story')
        requestPreview(nodeId, false)
      }}
      onDuplicateSnippet={duplicateSnippet}
      onDeleteSnippet={(nodeId: string): void => {
        setSelectedNodeId(nodeId)
        setDeleteSnippetId(nodeId)
      }}
      onToggleParallel={toggleParallel}
      onMoveSnippet={moveSnippet}
      onSelectAsset={(selection: EditorAssetSelection): void => {
        setSelectedAsset(selection)
        setActivePanel('assets')
        if (phoneLayout) setMobileBottomTab('properties')
      }}
      onAddDialogOpenChange={setAddDialogOpen}
      onAddSnippet={addSnippet}
      onImportAsset={(kind: Exclude<ProjectAssetKind, 'models'>): void => {
        void importAsset(kind)
      }}
      onRegisterModel={(): void => setRegisterModelOpen(true)}
    />
  )

  const inspectorNode: JSX.Element =
    activePanel === 'assets' ? (
      <EditorAssetInspector
        assets={previewInput.assets}
        selectedAsset={selectedAsset}
        onModelChange={updateModelAsset}
        onFileAssetChange={updateFileAsset}
        onRename={(selection: EditorAssetSelection, key: string): void => {
          void renameAsset(selection, key)
        }}
        onDelete={(selection: EditorAssetSelection): void => {
          void requestDeleteAsset(selection)
        }}
      />
    ) : (
      <EditorInspector
        story={story}
        selectedNode={selectedNode}
        selectedNodePath={displayedNodePath}
        assets={previewInput.assets}
        modelRegistry={previewInput.modelRegistry}
        onStoryChange={commitStory}
        onInputBlur={flushInputMerge}
        onDuplicate={duplicateSelectedSnippet}
        onDelete={(): void => setDeleteSnippetId(selectedNode?.id ?? null)}
      />
    )

  const previewNode: JSX.Element = (
    <EditorPreview
      input={previewInput}
      story={story}
      previewRequest={previewRequest}
      previewTargetNodeId={previewTargetNode?.id ?? null}
      pauseAfterPreviewTarget={pauseAfterPreviewTarget}
      onActiveSnippetIdsChange={setActiveSnippetIds}
      onPreviewFromBeginning={(): void => requestPreview(null, false)}
      compact={compactChrome}
    />
  )

  return (
    <main
      className={cn(
        'flex min-w-0 flex-col overflow-hidden bg-background text-foreground',
        embedInShell ? 'h-full' : 'h-screen'
      )}
    >
      <header
        className={cn(
          'flex shrink-0 items-center border-b bg-background px-2 sm:px-3',
          phoneLayout && 'flex-wrap content-start px-2 pb-1',
          embedInShell && phoneLayout
            ? 'pt-[env(safe-area-inset-top)]'
            : embedInShell
              ? 'h-[calc(52px+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)]'
              : phoneLayout
                ? undefined
                : 'h-[52px]'
        )}
      >
        <div
          className={cn('flex min-w-0 items-center gap-1.5 sm:gap-2', phoneLayout && 'h-12 flex-1')}
        >
          {embedInShell ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-9 shrink-0"
              aria-label={t('common.back')}
              title={t('common.back')}
              onClick={(): void => {
                void flushEditorWrites()
                  .then((saved: boolean): void => {
                    if (saved) void closeEditorWindow()
                  })
                  .catch((error: unknown): void => {
                    setActionError(describeError(error, t('editor.saveProjectFailed')))
                  })
              }}
            >
              <ArrowLeft className="size-4" />
            </Button>
          ) : null}
          <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-foreground text-background">
            <Clapperboard className="size-4" />
          </div>
          <p className="min-w-0 truncate text-sm font-semibold">{loadedProject.metadata.title}</p>
          <span
            aria-label={isDirty ? t('editor.unsavedChanges') : undefined}
            className={cn(
              'size-1.5 shrink-0 rounded-full bg-amber-500 transition-opacity duration-300 ease-out',
              isDirty ? 'opacity-100' : 'opacity-0'
            )}
          />
        </div>

        <div
          className={cn(
            'ml-2 flex items-center gap-0.5 sm:ml-5 sm:gap-1 sm:border-l sm:pl-4',
            phoneLayout && 'ml-auto h-12'
          )}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9"
            aria-label={t('common.undo')}
            title={t('common.undo')}
            disabled={history.past.length === 0}
            onClick={(): void => dispatchHistory({ type: 'undo' })}
          >
            <Undo2 className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9"
            aria-label={t('common.redo')}
            title={t('common.redo')}
            disabled={history.future.length === 0}
            onClick={(): void => dispatchHistory({ type: 'redo' })}
          >
            <Redo2 className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn('size-9', storySaveStatus === 'error' && 'text-destructive')}
            aria-label={saveButtonTitle}
            title={saveButtonTitle}
            onClick={(): void => {
              void flushEditorWrites()
            }}
          >
            <Save className="size-4" />
          </Button>
        </div>

        <div
          className={cn(
            'ml-auto flex min-w-0 items-center gap-1 sm:gap-1.5',
            phoneLayout && 'ml-0 h-12 w-full border-t px-0.5 pt-1'
          )}
        >
          {visibleError && (
            <span className="hidden max-w-40 truncate text-xs text-destructive sm:inline sm:max-w-72">
              {visibleError}
            </span>
          )}
          <Button
            type="button"
            variant="outline"
            size="icon"
            className={phoneLayout ? 'size-10 shrink-0' : compactChrome ? 'size-9' : 'size-8'}
            aria-label={t('projectArchive.export')}
            title={t('projectArchive.export')}
            disabled={exportingProject || editorSaving}
            onClick={(): void => void exportCurrentProject()}
          >
            {exportingProject ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Package className="size-4" />
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            size={phoneLayout ? 'sm' : compactChrome ? 'icon' : 'sm'}
            className={phoneLayout ? 'h-10 min-w-0 flex-1' : compactChrome ? 'size-9' : undefined}
            data-tour="editor-preview-button"
            disabled={!selectedNode}
            aria-label={t('editor.preview')}
            title={t('editor.preview')}
            onClick={(): void => requestPreview(selectedNode?.id ?? null, false)}
          >
            <CirclePlay className="size-3.5" />
            {phoneLayout || !compactChrome ? t('editor.preview') : null}
          </Button>
          <Button
            type="button"
            size={phoneLayout ? 'sm' : compactChrome ? 'icon' : 'sm'}
            className={phoneLayout ? 'h-10 min-w-0 flex-1' : compactChrome ? 'size-9' : undefined}
            data-tour="editor-player-button"
            title={t('editor.playSavedTitle')}
            aria-label={t('editor.playSaved')}
            onClick={(): void => void playSavedProject()}
          >
            <Play className="size-3.5 fill-current" />
            {phoneLayout || !compactChrome ? t('editor.playSaved') : null}
          </Button>
        </div>
      </header>

      {mobileLandscapeLayout ? (
        <div
          className="grid min-h-0 flex-1 grid-cols-[minmax(160px,0.8fr)_minmax(260px,1.4fr)_minmax(200px,1fr)] overflow-hidden"
          inert={projectMutationInProgress}
        >
          <div className="min-h-0 overflow-hidden border-r">{sidebarNode}</div>
          <div className="min-h-0 overflow-hidden border-r bg-black">{previewNode}</div>
          <div className="min-h-0 overflow-hidden">{inspectorNode}</div>
        </div>
      ) : phoneLayout ? (
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          inert={projectMutationInProgress}
        >
          <div className="h-[calc(56.25vw+5.25rem)] max-h-[44dvh] w-full shrink-0 overflow-hidden border-b bg-black">
            {previewNode}
          </div>
          <div className="flex h-12 shrink-0 items-center border-b bg-muted/25 px-3">
            <div className="grid min-w-0 flex-1 grid-cols-2 gap-1 rounded-lg bg-muted p-1">
              <button
                type="button"
                className={cn(
                  'h-9 rounded-md text-sm font-medium transition-colors',
                  mobileBottomTab === 'outline'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground'
                )}
                onClick={(): void => setMobileBottomTab('outline')}
              >
                {t('editor.outline')}
              </button>
              <button
                type="button"
                className={cn(
                  'h-9 rounded-md text-sm font-medium transition-colors',
                  mobileBottomTab === 'properties'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground'
                )}
                onClick={(): void => setMobileBottomTab('properties')}
              >
                {t('editor.properties')}
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden [&>aside]:border-r-0">
            {mobileBottomTab === 'outline' ? sidebarNode : inspectorNode}
          </div>
        </div>
      ) : tabletLayout ? (
        <div
          className="grid min-h-0 flex-1 grid-cols-[minmax(220px,0.9fr)_minmax(320px,1.4fr)] overflow-hidden"
          inert={projectMutationInProgress}
        >
          <div className="min-h-0 overflow-hidden border-r">{sidebarNode}</div>
          <div className="grid min-h-0 grid-rows-[minmax(240px,1.1fr)_minmax(220px,0.9fr)] overflow-hidden">
            <div className="min-h-0 overflow-hidden border-b">{previewNode}</div>
            <div className="min-h-0 overflow-hidden">{inspectorNode}</div>
          </div>
        </div>
      ) : (
        <div
          className="grid min-h-0 flex-1 grid-cols-[minmax(240px,0.86fr)_minmax(420px,1.72fr)_minmax(300px,1fr)] overflow-hidden"
          inert={projectMutationInProgress}
        >
          {sidebarNode}
          {previewNode}
          {inspectorNode}
        </div>
      )}

      <EditorProductTour
        active={
          settings !== null &&
          normalizeOnboardingSettings(settings.onboarding).editorTourVersion < EDITOR_TOUR_VERSION
        }
        onComplete={onCompleteEditorTour}
      />

      {editorNotice && (
        <Toast
          key={editorNotice.id}
          message={editorNotice.message}
          variant={editorNotice.variant}
          closeLabel={t('common.close')}
          onDismiss={(): void => setEditorNotice(null)}
        />
      )}

      <AlertDialog
        open={deleteSnippetNode !== null}
        onOpenChange={(open: boolean): void => {
          if (!open) setDeleteSnippetId(null)
        }}
      >
        <AlertDialogContent className="select-none">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('editor.deleteSnippetTitle', {
                type: deleteSnippetNode?.type ?? t('editor.unknownSnippet')
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteSnippetNode && countDescendants(deleteSnippetNode) > 1
                ? t('editor.deleteSnippetNested', {
                    count: countDescendants(deleteSnippetNode)
                  })
                : t('editor.deleteSnippetSingle')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={deleteSelectedSnippet}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ProjectSwitchDialog
        targetProjectName={projectSwitchNeedsDecision ? pendingProjectName : null}
        saving={editorSaving}
        onAction={handleProjectSwitch}
      />
      <AssetDeleteDialog
        prompt={assetDeletePrompt}
        onCancel={(): void => setAssetDeletePrompt(null)}
        onConfirm={confirmDeleteAsset}
      />
      <ModelRegistrationDialog
        open={registerModelOpen}
        registry={previewInput.modelRegistry}
        onOpenChange={setRegisterModelOpen}
        onRegister={async (modelId: string, key: string, name: string): Promise<void> => {
          try {
            const saved: boolean = await flushEditorWrites()
            if (!saved) throw new Error(t('editor.saveCurrentChangesFailed'))
            await runProjectMutation(async (): Promise<void> => {
              const result: ProjectAssetMutationResult = await registerProjectModel(
                previewInput.projectName,
                modelId,
                key || undefined,
                name || undefined
              )
              replaceAssets(result.assets)
              setSelectedAsset({ kind: 'models', key: result.key })
              setActivePanel('assets')
              setRegisterModelOpen(false)
            })
          } catch (error: unknown) {
            setActionError(describeError(error, t('editor.registerModelFailed')))
            throw error
          }
        }}
        onImport={async (
          sourcePath: string,
          archiveEntry: string | undefined,
          key: string,
          name: string
        ): Promise<void> => {
          try {
            const saved: boolean = await flushEditorWrites()
            if (!saved) throw new Error(t('editor.saveCurrentChangesFailed'))
            await runProjectMutation(async (): Promise<void> => {
              const imported: ImportedModelResult = await importGlobalModel(
                sourcePath,
                name || undefined,
                archiveEntry
              )
              replaceModelRegistry(imported.registry)
              const result: ProjectAssetMutationResult = await registerProjectModel(
                previewInput.projectName,
                imported.modelId,
                key || undefined,
                name || undefined
              )
              replaceAssets(result.assets)
              setSelectedAsset({ kind: 'models', key: result.key })
              setActivePanel('assets')
              setRegisterModelOpen(false)
            })
          } catch (error: unknown) {
            setActionError(describeError(error, t('editor.importModelFailed')))
            throw error
          }
        }}
      />
    </main>
  )
}

function EditorStateMessage({
  title,
  detail,
  loading = false,
  onRetry
}: {
  title: string
  detail: string
  loading?: boolean
  onRetry?: () => void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <main className="flex h-screen items-center justify-center bg-background p-8 text-center">
      <div className="max-w-md">
        {loading && (
          <LoaderCircle className="mx-auto mb-4 size-5 animate-spin text-muted-foreground" />
        )}
        <h1 className="text-base font-semibold">{title}</h1>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{detail}</p>
        {onRetry && (
          <Button type="button" variant="outline" size="sm" className="mt-5" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        )}
      </div>
    </main>
  )
}

function ProjectSwitchDialog({
  targetProjectName,
  saving,
  onAction
}: {
  targetProjectName: string | null
  saving: boolean
  onAction: (action: 'save' | 'discard' | 'cancel') => Promise<void>
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <AlertDialog open={targetProjectName !== null}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('editor.autosaveFailed')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('editor.projectSwitchSaveFailed', { name: targetProjectName ?? '' })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={saving}
            onClick={(): void => void onAction('cancel')}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={(): void => void onAction('discard')}
          >
            {t('editor.discardChanges')}
          </Button>
          <Button type="button" disabled={saving} onClick={(): void => void onAction('save')}>
            {t('editor.retryAndSwitch')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function AssetDeleteDialog({
  prompt,
  onCancel,
  onConfirm
}: {
  prompt: AssetDeletePrompt | null
  onCancel: () => void
  onConfirm: () => Promise<void>
}): JSX.Element {
  const { t } = useTranslation()
  const blocked: boolean = Boolean(prompt && prompt.references.length > 0)
  return (
    <AlertDialog
      open={prompt !== null}
      onOpenChange={(open: boolean): void => {
        if (!open) onCancel()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {blocked ? t('editor.referencedAssetTitle') : t('editor.deleteAssetTitle')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {blocked
              ? t('editor.referencedAssetDescription', {
                  count: prompt?.references.length ?? 0,
                  key: prompt?.selection.key ?? ''
                })
              : t('editor.deleteAssetDescription', {
                  key: prompt?.selection.key ?? ''
                })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {blocked && (
          <ul className="max-h-40 space-y-1 overflow-auto rounded-md border bg-muted/20 px-3 py-2 font-mono text-xs text-muted-foreground">
            {prompt?.references.map(
              (reference: ProjectAssetReference): JSX.Element => (
                <li key={`${reference.path}:${reference.snippetId ?? reference.snippetType}`}>
                  {reference.path} · {reference.snippetType}
                </li>
              )
            )}
          </ul>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>
            {blocked ? t('editor.acknowledged') : t('common.cancel')}
          </AlertDialogCancel>
          {!blocked && (
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(): void => void onConfirm()}
            >
              {t('common.delete')}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function ModelRegistrationDialog({
  open,
  registry,
  onOpenChange,
  onRegister,
  onImport
}: {
  open: boolean
  registry: ModelRegistry
  onOpenChange: (open: boolean) => void
  onRegister: (modelId: string, key: string, name: string) => Promise<void>
  onImport: (
    sourcePath: string,
    archiveEntry: string | undefined,
    key: string,
    name: string
  ) => Promise<void>
}): JSX.Element {
  const { t } = useTranslation()
  const mobileRuntime: boolean = isMobileRuntime()
  const modelEntries = useMemo(
    (): [string, ModelRegistry['models'][string]][] =>
      Object.entries(registry.models).sort(([left], [right]): number => left.localeCompare(right)),
    [registry.models]
  )
  const firstModelId: string = modelEntries[0]?.[0] ?? ''
  const [mode, setMode] = useState<'existing' | 'import'>('existing')
  const [modelId, setModelId] = useState<string>('')
  const [sourcePath, setSourcePath] = useState<string>('')
  const [archiveEntry, setArchiveEntry] = useState<string | undefined>(undefined)
  const [pendingArchivePath, setPendingArchivePath] = useState<string>('')
  const [archiveCandidates, setArchiveCandidates] = useState<readonly ModelArchiveCandidate[]>([])
  const [selectedArchiveEntry, setSelectedArchiveEntry] = useState<string>('')
  const [archiveSelectionOpen, setArchiveSelectionOpen] = useState<boolean>(false)
  const [inspectingArchive, setInspectingArchive] = useState<boolean>(false)
  const [key, setKey] = useState<string>('')
  const [name, setName] = useState<string>('')
  const [submitting, setSubmitting] = useState<boolean>(false)
  const [error, setError] = useState<string>('')

  useEffect((): void => {
    if (!open) return
    setMode('existing')
    setModelId(firstModelId)
    setSourcePath('')
    setArchiveEntry(undefined)
    setPendingArchivePath('')
    setArchiveCandidates([])
    setSelectedArchiveEntry('')
    setArchiveSelectionOpen(false)
    setInspectingArchive(false)
    setKey('')
    setName('')
    setSubmitting(false)
    setError('')
  }, [firstModelId, open])

  async function chooseModelEntry(): Promise<void> {
    const selected = await openFileDialog({
      multiple: false,
      directory: false,
      title: t('editor.chooseLive2dEntry'),
      filters: [
        {
          name: t('editor.live2dModel'),
          extensions: mobileRuntime ? ['zip'] : ['json', 'zip']
        }
      ]
    })
    if (typeof selected !== 'string') return

    setError('')
    if (!mobileRuntime && !selected.toLocaleLowerCase().endsWith('.zip')) {
      setSourcePath(selected)
      setArchiveEntry(undefined)
      return
    }

    setSourcePath('')
    setArchiveEntry(undefined)
    setInspectingArchive(true)
    try {
      const inspection = await inspectModelArchive(selected)
      const recognized: ModelArchiveCandidate[] = inspection.candidates.filter(
        (candidate: ModelArchiveCandidate): boolean => candidate.recognized
      )
      if (recognized.length === 1) {
        setSourcePath(selected)
        setArchiveEntry(recognized[0].path)
        return
      }

      const firstCandidate: ModelArchiveCandidate | undefined =
        recognized[0] ?? inspection.candidates[0]
      if (!firstCandidate) {
        setError(t('editor.noJsonEntry'))
        return
      }

      setPendingArchivePath(selected)
      setArchiveCandidates(recognized.length > 1 ? recognized : inspection.candidates)
      setSelectedArchiveEntry(firstCandidate.path)
      setArchiveSelectionOpen(true)
    } catch (inspectionError: unknown) {
      setSourcePath('')
      setArchiveEntry(undefined)
      setError(describeError(inspectionError, t('editor.inspectModelZipFailed')))
    } finally {
      setInspectingArchive(false)
    }
  }

  async function submit(): Promise<void> {
    if (submitting) return
    setSubmitting(true)
    setError('')
    try {
      if (mode === 'existing') {
        await onRegister(modelId, key, name)
      } else {
        await onImport(sourcePath, archiveEntry, key, name)
      }
    } catch (submitError: unknown) {
      setError(
        describeError(
          submitError,
          mode === 'existing' ? t('editor.registerModelFailed') : t('editor.importModelFailed')
        )
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg min-w-0 overflow-hidden">
        <DialogHeader className="min-w-0">
          <DialogTitle>{t('editor.addModel')}</DialogTitle>
          <DialogDescription>{t('editor.addModelDescription')}</DialogDescription>
        </DialogHeader>

        <div className="grid min-w-0 grid-cols-2 rounded-md bg-muted p-1">
          <button
            type="button"
            className={cn(
              'h-8 rounded-sm text-xs transition-colors',
              mode === 'existing'
                ? 'bg-background font-medium shadow-xs'
                : 'text-muted-foreground hover:text-foreground'
            )}
            disabled={submitting}
            onClick={(): void => {
              setMode('existing')
              setError('')
            }}
          >
            {t('editor.existingModels')}
          </button>
          <button
            type="button"
            className={cn(
              'h-8 rounded-sm text-xs transition-colors',
              mode === 'import'
                ? 'bg-background font-medium shadow-xs'
                : 'text-muted-foreground hover:text-foreground'
            )}
            disabled={submitting}
            onClick={(): void => {
              setMode('import')
              setError('')
            }}
          >
            {t('editor.importModel')}
          </button>
        </div>

        <div className="min-w-0 space-y-4">
          {mode === 'existing' ? (
            <label className="block min-w-0 text-xs font-medium text-muted-foreground">
              {t('editor.globalModel')}
              {modelEntries.length > 0 ? (
                <select
                  className="mt-2 h-9 w-full min-w-0 max-w-full rounded-md border bg-background px-2 text-sm text-foreground"
                  value={modelId}
                  disabled={submitting}
                  onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
                    setModelId(event.currentTarget.value)
                  }
                >
                  {modelEntries.map(
                    ([id, entry]): JSX.Element => (
                      <option key={id} value={id}>
                        {entry.name ?? id} · {id}
                      </option>
                    )
                  )}
                </select>
              ) : (
                <span className="mt-2 block rounded-md border border-dashed px-3 py-4 text-sm font-normal">
                  {t('editor.noGlobalModels')}
                </span>
              )}
            </label>
          ) : (
            <div className="min-w-0 max-w-full overflow-hidden rounded-md border border-dashed p-4">
              <p className="text-sm font-medium">{t('editor.chooseModelSource')}</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {mobileRuntime ? t('editor.mobileModelZipHint') : t('editor.desktopModelHint')}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                disabled={submitting || inspectingArchive}
                onClick={(): void => void chooseModelEntry()}
              >
                {inspectingArchive ? t('editor.inspectingZip') : t('common.chooseFile')}
              </Button>
              {sourcePath && (
                <p
                  className="mt-3 block w-full min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px] text-muted-foreground"
                  title={sourcePath}
                >
                  {fileNameFromPath(sourcePath)}
                  {archiveEntry ? ` · ${archiveEntry}` : ''}
                </p>
              )}
            </div>
          )}

          <label className="block min-w-0 text-xs font-medium text-muted-foreground">
            {t('editor.optionalDisplayName')}
            <Input
              value={name}
              disabled={submitting}
              className="mt-2 h-9"
              onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                setName(event.currentTarget.value)
              }
            />
          </label>
          <details className="group min-w-0 max-w-full overflow-hidden rounded-md border bg-muted/15">
            <summary className="flex h-9 cursor-pointer list-none items-center gap-2 px-3 text-xs font-medium text-muted-foreground select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
              {t('editor.advanced')}
            </summary>
            <div className="border-t px-3 py-3">
              <label className="block text-xs font-medium text-muted-foreground">
                {t('editor.projectAssetKey')}
                <Input
                  value={key}
                  disabled={submitting}
                  placeholder={t('editor.autoGeneratePlaceholder')}
                  className="mt-2 h-9 font-mono text-xs"
                  onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                    setKey(event.currentTarget.value)
                  }
                />
              </label>
            </div>
          </details>
          {error && <p className="min-w-0 break-all text-xs leading-5 text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={(): void => onOpenChange(false)}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            disabled={
              submitting || inspectingArchive || (mode === 'existing' ? !modelId : !sourcePath)
            }
            onClick={(): void => void submit()}
          >
            {submitting
              ? t('common.processing')
              : mode === 'existing'
                ? t('editor.addToProject')
                : t('editor.importAndAdd')}
          </Button>
        </DialogFooter>
        <Dialog open={archiveSelectionOpen} onOpenChange={setArchiveSelectionOpen}>
          <DialogContent className="max-w-xl min-w-0 overflow-hidden">
            <DialogHeader>
              <DialogTitle>{t('editor.chooseZipEntry')}</DialogTitle>
              <DialogDescription>
                {archiveCandidates.some(
                  (candidate: ModelArchiveCandidate): boolean => candidate.recognized
                )
                  ? t('editor.chooseRecognizedEntry')
                  : t('editor.chooseJsonEntry')}
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-80 space-y-1 overflow-y-auto rounded-md border bg-muted/15 p-1.5 scrollbar-thin scrollbar-thumb-muted-foreground/25 scrollbar-track-transparent">
              {archiveCandidates.map(
                (candidate: ModelArchiveCandidate): JSX.Element => (
                  <button
                    key={candidate.path}
                    type="button"
                    className={cn(
                      'flex w-full min-w-0 items-center gap-3 rounded-sm px-3 py-2 text-left transition-colors',
                      selectedArchiveEntry === candidate.path
                        ? 'bg-emerald-500/10 ring-1 ring-emerald-500/40'
                        : 'hover:bg-accent'
                    )}
                    onClick={(): void => setSelectedArchiveEntry(candidate.path)}
                  >
                    {candidate.recognized ? (
                      <FileArchive className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <FileJson className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                    )}
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-xs"
                      title={candidate.path}
                    >
                      {candidate.path}
                    </span>
                    <span
                      className={cn(
                        'shrink-0 rounded-sm px-1.5 py-0.5 text-[10px]',
                        candidate.recognized
                          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                          : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                      )}
                    >
                      {candidate.recognized ? t('editor.recognized') : t('editor.plainJson')}
                    </span>
                  </button>
                )
              )}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={(): void => setArchiveSelectionOpen(false)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                type="button"
                disabled={!selectedArchiveEntry}
                onClick={(): void => {
                  setSourcePath(pendingArchivePath)
                  setArchiveEntry(selectedArchiveEntry)
                  setArchiveSelectionOpen(false)
                }}
              >
                {t('editor.useEntry')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  )
}

async function loadEditorProject(projectName: string): Promise<LoadedEditorProject> {
  const [metadata, story, assets, modelRegistry, settings, dataPath, projectPath] =
    await Promise.all([
      getProjectMetadata(projectName),
      getProjectStory(projectName),
      getProjectAssets(projectName),
      getModelRegistry(),
      getSettings(),
      getDataPath(),
      getProjectPath(projectName)
    ])
  if (!metadata) {
    throw new Error(i18n.t('project.metadataMissing', { name: projectName }))
  }
  return {
    metadata,
    story,
    previewInput: {
      projectName,
      dataPath,
      projectPath,
      settings,
      modelRegistry,
      assets
    }
  }
}

function collectParallelIds(story: EditorStory): ReadonlySet<string> {
  const ids: Set<string> = new Set()
  function collect(nodes: readonly EditorStory['snippets'][number][]): void {
    for (const node of nodes) {
      if (node.type !== 'Parallel') continue
      ids.add(node.id)
      collect(node.snippets)
    }
  }
  collect(story.snippets)
  return ids
}

function firstAssetSelection(assets: ProjectAssets): EditorAssetSelection | null {
  const kinds: readonly ProjectAssetKind[] = ['backgrounds', 'models', 'voices']
  for (const kind of kinds) {
    const key: string | undefined = Object.keys(assets[kind])[0]
    if (key) return { kind, key }
  }
  return null
}

function countDescendants(node: NonNullable<ReturnType<typeof findEditorNode>>): number {
  if (node.type !== 'Parallel') return 1
  return (
    1 + node.snippets.reduce((count: number, child): number => count + countDescendants(child), 0)
  )
}

function describeError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function storyFingerprint(story: EditorStory): string {
  return JSON.stringify(story)
}

function waitForDelay(delayMs: number): Promise<void> {
  return new Promise<void>((resolve: () => void): void => {
    window.setTimeout(resolve, delayMs)
  })
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}
