import type { ChangeEvent, JSX } from 'react'
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import {
  ChevronRight,
  CirclePlay,
  Clapperboard,
  LoaderCircle,
  Play,
  Redo2,
  Save,
  Undo2
} from 'lucide-react'
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
import { describeError as describeLogError, logger } from '@/lib/logger'
import type { ModelRegistry } from '@/modelRegistry/schema'
import { getModelRegistry, importGlobalModel } from '@/modelRegistry/api'
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
  ProjectAssetReference,
  ProjectAssets,
  VoiceAsset
} from '@/project/assets'
import type { ProjectMetadata } from '@/project/metadata'
import { getSettings } from '@/settings/api'
import { getProjectStory, setProjectStory } from '@/story/api'
import type { StoryData } from '@/story'
import { getDataPath } from '@/workspace/api'
import { openPlayerWindow } from '@/windows/api'
import { useWindowProjectName } from '@/windows/useWindowProjectName'
import {
  ASSET_KIND_LABELS,
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

const EMPTY_ASSETS: ProjectAssets = {
  models: {},
  backgrounds: {},
  voices: {}
}

const INITIAL_STORY: EditorStory = createDocumentHistory({ version: 1, snippets: [] }).present

export default function App(): JSX.Element {
  const requestedProjectName = useWindowProjectName()
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
  const [expandedParallelIds, setExpandedParallelIds] = useState<ReadonlySet<string>>(
    (): ReadonlySet<string> => new Set()
  )
  const [selectedAsset, setSelectedAsset] = useState<EditorAssetSelection | null>(null)
  const [addDialogOpen, setAddDialogOpen] = useState<boolean>(false)
  const [deleteSnippetId, setDeleteSnippetId] = useState<string | null>(null)
  const [assetDeletePrompt, setAssetDeletePrompt] = useState<AssetDeletePrompt | null>(null)
  const [pendingProjectName, setPendingProjectName] = useState<string | null>(null)
  const [previewRequest, setPreviewRequest] = useState<number>(0)
  const [previewTargetNodeId, setPreviewTargetNodeId] = useState<string | null>(null)
  const [savingStory, setSavingStory] = useState<boolean>(false)
  const [registerModelOpen, setRegisterModelOpen] = useState<boolean>(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const inputMergeTimerRef = useRef<number | null>(null)
  const blockedSwitchProjectRef = useRef<string | null>(null)
  const assetsRef = useRef<ProjectAssets>(EMPTY_ASSETS)
  const assetWriteQueueRef = useRef<Promise<void>>(Promise.resolve())

  const story: EditorStory = history.present
  const isDirty: boolean = !storiesEqual(history.present, history.saved)
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

  useEffect((): void => {
    assetsRef.current = loadedProject?.previewInput.assets ?? EMPTY_ASSETS
  }, [loadedProject])

  useEffect((): (() => void) => {
    return (): void => {
      if (inputMergeTimerRef.current !== null) {
        window.clearTimeout(inputMergeTimerRef.current)
      }
    }
  }, [])

  useEffect((): void => {
    if (!requestedProjectName || requestedProjectName === activeProjectName) return
    if (blockedSwitchProjectRef.current === requestedProjectName) return

    if (activeProjectName && loadedProject && isDirty) {
      setPendingProjectName(requestedProjectName)
      return
    }

    setActiveProjectName(requestedProjectName)
  }, [activeProjectName, isDirty, loadedProject, requestedProjectName])

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
        dispatchHistory({ type: 'load', story: nextHistory.present })
        setLoadedProject(project)
        setSelectedNodeId(nextHistory.present.snippets[0]?.id ?? null)
        setPreviewTargetNodeId(null)
        setSelectedAsset(firstAssetSelection(project.previewInput.assets))
        setExpandedParallelIds(collectParallelIds(nextHistory.present))
        setSearchQuery('')
        setActivePanel('story')
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
        setLoadState({ status: 'error', error: describeError(error, '加载项目失败') })
      })

    return (): void => {
      cancelled = true
    }
  }, [activeProjectName])

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

  function commitStory(nextStory: EditorStory, mergeKey?: string): void {
    dispatchHistory({ type: 'commit', story: nextStory, mergeKey })
    if (!mergeKey) return
    if (inputMergeTimerRef.current !== null) window.clearTimeout(inputMergeTimerRef.current)
    inputMergeTimerRef.current = window.setTimeout((): void => {
      dispatchHistory({ type: 'flush-merge' })
      inputMergeTimerRef.current = null
    }, 550)
  }

  function requestPreview(targetNodeId: string | null): void {
    setPreviewTargetNodeId(targetNodeId)
    setPreviewRequest((current: number): number => current + 1)
  }

  async function playSavedProject(): Promise<void> {
    if (!loadedProject) return
    setActionError(null)
    try {
      await openPlayerWindow(loadedProject.previewInput.projectName)
    } catch (error: unknown) {
      setActionError(describeError(error, '打开播放器失败'))
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
    setSavingStory(true)
    setActionError(null)
    try {
      await setProjectStory(loadedProject.previewInput.projectName, story)
      dispatchHistory({ type: 'save' })
      return true
    } catch (error: unknown) {
      setActionError(describeError(error, '保存 story.json 失败'))
      return false
    } finally {
      setSavingStory(false)
    }
  }

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
      setActionError(describeError(error, '添加片段失败'))
    }
  }

  function duplicateSelectedSnippet(): void {
    if (!selectedNode) return
    const duplication = duplicateSnippetSubtree(story, selectedNode.id)
    if (!duplication) return
    commitStory(duplication.story)
    setSelectedNodeId(duplication.duplicatedId)
  }

  function deleteSelectedSnippet(): void {
    if (!deleteSnippetNode) return
    const nextStory = removeSnippetSubtree(story, deleteSnippetNode.id)
    commitStory(nextStory)
    setSelectedNodeId(nextStory.snippets[0]?.id ?? null)
    setDeleteSnippetId(null)
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
      title: `导入${ASSET_KIND_LABELS[kind]}`,
      filters: [{ name: ASSET_KIND_LABELS[kind], extensions: [...extensions] }]
    })
    if (!sourcePath || Array.isArray(sourcePath)) return

    setActionError(null)
    try {
      const result = await importProjectAsset(
        loadedProject.previewInput.projectName,
        kind,
        sourcePath
      )
      replaceAssets(result.assets)
      setSelectedAsset({ kind, key: result.key })
      setActivePanel('assets')
    } catch (error: unknown) {
      setActionError(describeError(error, `导入${ASSET_KIND_LABELS[kind]}失败`))
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
    assetWriteQueueRef.current = assetWriteQueueRef.current
      .catch((): void => undefined)
      .then(async (): Promise<void> => {
        await setProjectAssets(projectName, nextAssets)
      })
      .catch((error: unknown): void => {
        setActionError(describeError(error, '保存 assets.json 失败'))
      })
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
    if (!loadedProject || isDirty) {
      setActionError('请先保存 story，再重命名资源键。')
      return
    }
    try {
      const nextAssets = await renameProjectAsset(
        loadedProject.previewInput.projectName,
        selection.kind,
        selection.key,
        nextKey
      )
      replaceAssets(nextAssets)
      const rewrittenStory = renameAssetReferences(story, selection.kind, selection.key, nextKey)
      dispatchHistory({ type: 'load', story: rewrittenStory })
      setSelectedAsset({ kind: selection.kind, key: nextKey })
    } catch (error: unknown) {
      setActionError(describeError(error, '重命名资源键失败'))
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
            path: `当前内存 story · ${reference.snippetId.slice(0, 8)}`
          })
        )
      })
      return
    }
    try {
      const references = await getProjectAssetReferences(
        loadedProject.previewInput.projectName,
        selection.kind,
        selection.key
      )
      setAssetDeletePrompt({ selection, references })
    } catch (error: unknown) {
      setActionError(describeError(error, '检查资源引用失败'))
    }
  }

  async function confirmDeleteAsset(): Promise<void> {
    if (!loadedProject || !assetDeletePrompt || assetDeletePrompt.references.length > 0) return
    try {
      const nextAssets = await deleteProjectAsset(
        loadedProject.previewInput.projectName,
        assetDeletePrompt.selection.kind,
        assetDeletePrompt.selection.key
      )
      replaceAssets(nextAssets)
      setSelectedAsset(firstAssetSelection(nextAssets))
      setAssetDeletePrompt(null)
    } catch (error: unknown) {
      setActionError(describeError(error, '删除资源失败'))
      setAssetDeletePrompt(null)
    }
  }

  async function handleProjectSwitch(action: 'save' | 'discard' | 'cancel'): Promise<void> {
    const targetProjectName: string | null = pendingProjectName
    if (!targetProjectName) return
    if (action === 'save') {
      const saved: boolean = await saveStory()
      if (!saved) return
    }
    if (action === 'cancel') {
      blockedSwitchProjectRef.current = targetProjectName
      setPendingProjectName(null)
      return
    }
    blockedSwitchProjectRef.current = null
    setPendingProjectName(null)
    setActiveProjectName(targetProjectName)
  }

  function retryLoad(): void {
    if (!activeProjectName) return
    setActiveProjectName(null)
    window.setTimeout((): void => setActiveProjectName(activeProjectName), 0)
  }

  if (!requestedProjectName && !activeProjectName) {
    return <EditorStateMessage title="没有打开项目" detail="请从项目列表打开一个编辑器窗口。" />
  }

  if (loadState.status === 'error') {
    return <EditorStateMessage title="项目加载失败" detail={loadState.error} onRetry={retryLoad} />
  }

  if (loadState.status === 'loading' || !loadedProject || !previewInput) {
    return (
      <EditorStateMessage title="正在加载项目" detail="读取 story、assets 与模型注册表…" loading />
    )
  }

  return (
    <main className="flex h-screen min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-[52px] shrink-0 items-center border-b bg-background px-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-foreground text-background">
            <Clapperboard className="size-4" />
          </div>
          <p className="min-w-0 truncate text-sm font-semibold">{loadedProject.metadata.title}</p>
          {isDirty && <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />}
        </div>

        <div className="ml-5 flex items-center gap-1 border-l pl-4">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="撤销"
            title="撤销"
            disabled={history.past.length === 0 || savingStory}
            onClick={(): void => dispatchHistory({ type: 'undo' })}
          >
            <Undo2 className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="重做"
            title="重做"
            disabled={history.future.length === 0 || savingStory}
            onClick={(): void => dispatchHistory({ type: 'redo' })}
          >
            <Redo2 className="size-4" />
          </Button>
          <Button
            type="button"
            variant={isDirty ? 'default' : 'outline'}
            size="sm"
            className="ml-1"
            disabled={savingStory}
            onClick={(): void => {
              void saveStory()
            }}
          >
            {savingStory ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Save className="size-3.5" />
            )}
            {isDirty ? '保存修改' : '已保存'}
          </Button>
        </div>

        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          {actionError && (
            <span className="max-w-72 truncate text-xs text-destructive">{actionError}</span>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!selectedNode}
            onClick={(): void => requestPreview(selectedNode?.id ?? null)}
          >
            <CirclePlay className="size-3.5" />
            预览
          </Button>
          <Button
            type="button"
            size="sm"
            title="使用 Player 播放已保存内容"
            onClick={(): void => void playSavedProject()}
          >
            <Play className="size-3.5 fill-current" />
            播放
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(240px,0.86fr)_minmax(420px,1.72fr)_minmax(300px,1fr)] overflow-hidden">
        <EditorSidebar
          activePanel={activePanel}
          searchQuery={searchQuery}
          treeNodes={treeNodes}
          selectedNodeId={selectedNode?.id ?? null}
          expandedParallelIds={expandedParallelIds}
          assets={previewInput.assets}
          selectedAsset={selectedAsset}
          addDialogOpen={addDialogOpen}
          onActivePanelChange={setActivePanel}
          onSearchQueryChange={setSearchQuery}
          onSelectNode={(nodeId: string): void => {
            setSelectedNodeId(nodeId)
            setActivePanel('story')
            requestPreview(nodeId)
          }}
          onToggleParallel={toggleParallel}
          onSelectAsset={(selection: EditorAssetSelection): void => {
            setSelectedAsset(selection)
            setActivePanel('assets')
          }}
          onAddDialogOpenChange={setAddDialogOpen}
          onAddSnippet={addSnippet}
          onImportAsset={(kind: Exclude<ProjectAssetKind, 'models'>): void => {
            void importAsset(kind)
          }}
          onRegisterModel={(): void => setRegisterModelOpen(true)}
        />

        <EditorPreview
          input={previewInput}
          story={story}
          selectedNodeId={selectedNode?.id ?? null}
          previewRequest={previewRequest}
          previewTargetNodeId={previewTargetNode?.id ?? null}
          onPreviewFromBeginning={(): void => requestPreview(null)}
        />

        {activePanel === 'assets' ? (
          <EditorAssetInspector
            assets={previewInput.assets}
            selectedAsset={selectedAsset}
            storyDirty={isDirty}
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
            onStoryChange={commitStory}
            onInputBlur={flushInputMerge}
            onDuplicate={duplicateSelectedSnippet}
            onDelete={(): void => setDeleteSnippetId(selectedNode?.id ?? null)}
          />
        )}
      </div>

      <AlertDialog
        open={deleteSnippetNode !== null}
        onOpenChange={(open: boolean): void => {
          if (!open) setDeleteSnippetId(null)
        }}
      >
        <AlertDialogContent className="select-none">
          <AlertDialogHeader>
            <AlertDialogTitle>删除 {deleteSnippetNode?.type ?? '片段'}？</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteSnippetNode && countDescendants(deleteSnippetNode) > 1
                ? `这会同时删除 ${countDescendants(deleteSnippetNode)} 个嵌套片段。`
                : '这会从当前故事中移除该片段。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={deleteSelectedSnippet}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ProjectSwitchDialog
        targetProjectName={pendingProjectName}
        saving={savingStory}
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
            const result = await registerProjectModel(
              previewInput.projectName,
              modelId,
              key || undefined,
              name || undefined
            )
            replaceAssets(result.assets)
            setSelectedAsset({ kind: 'models', key: result.key })
            setActivePanel('assets')
            setRegisterModelOpen(false)
          } catch (error: unknown) {
            setActionError(describeError(error, '注册模型失败'))
            throw error
          }
        }}
        onImport={async (sourcePath: string, key: string, name: string): Promise<void> => {
          try {
            const imported = await importGlobalModel(sourcePath, name || undefined)
            replaceModelRegistry(imported.registry)
            const result = await registerProjectModel(
              previewInput.projectName,
              imported.modelId,
              key || undefined,
              name || undefined
            )
            replaceAssets(result.assets)
            setSelectedAsset({ kind: 'models', key: result.key })
            setActivePanel('assets')
            setRegisterModelOpen(false)
          } catch (error: unknown) {
            setActionError(describeError(error, '导入模型失败'))
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
            重试
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
  return (
    <AlertDialog open={targetProjectName !== null}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>保存当前项目的修改？</AlertDialogTitle>
          <AlertDialogDescription>
            将切换到「{targetProjectName ?? ''}」。未保存的 story 修改可以保存、放弃，或取消切换。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={saving}
            onClick={(): void => void onAction('cancel')}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={(): void => void onAction('discard')}
          >
            放弃修改
          </Button>
          <Button type="button" disabled={saving} onClick={(): void => void onAction('save')}>
            保存并切换
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
          <AlertDialogTitle>{blocked ? '无法删除被引用的资源' : '删除资源？'}</AlertDialogTitle>
          <AlertDialogDescription>
            {blocked
              ? `以下 ${prompt?.references.length ?? 0} 个片段仍在引用「${prompt?.selection.key ?? ''}」：`
              : `将从项目中删除「${prompt?.selection.key ?? ''}」以及其受管文件。`}
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
          <AlertDialogCancel onClick={onCancel}>{blocked ? '知道了' : '取消'}</AlertDialogCancel>
          {!blocked && (
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(): void => void onConfirm()}
            >
              删除
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
  onImport: (sourcePath: string, key: string, name: string) => Promise<void>
}): JSX.Element {
  const modelEntries = useMemo(
    (): [string, ModelRegistry['models'][string]][] =>
      Object.entries(registry.models).sort(([left], [right]): number => left.localeCompare(right)),
    [registry.models]
  )
  const firstModelId: string = modelEntries[0]?.[0] ?? ''
  const [mode, setMode] = useState<'existing' | 'import'>('existing')
  const [modelId, setModelId] = useState<string>('')
  const [sourcePath, setSourcePath] = useState<string>('')
  const [key, setKey] = useState<string>('')
  const [name, setName] = useState<string>('')
  const [submitting, setSubmitting] = useState<boolean>(false)
  const [error, setError] = useState<string>('')

  useEffect((): void => {
    if (!open) return
    setMode('existing')
    setModelId(firstModelId)
    setSourcePath('')
    setKey('')
    setName('')
    setSubmitting(false)
    setError('')
  }, [firstModelId, open])

  async function chooseModelEntry(): Promise<void> {
    const selected = await openFileDialog({
      multiple: false,
      directory: false,
      title: '选择 Live2D 模型入口',
      filters: [{ name: 'Live2D 模型入口', extensions: ['json'] }]
    })
    if (typeof selected === 'string') {
      setSourcePath(selected)
      setError('')
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
        await onImport(sourcePath, key, name)
      }
    } catch (submitError: unknown) {
      setError(describeError(submitError, mode === 'existing' ? '注册模型失败' : '导入模型失败'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg min-w-0 overflow-hidden">
        <DialogHeader className="min-w-0">
          <DialogTitle>添加模型</DialogTitle>
          <DialogDescription>
            使用全局 models 中的已有模型，或从新的 Live2D 模型目录导入。
          </DialogDescription>
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
            全局已有模型
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
            导入新模型
          </button>
        </div>

        <div className="min-w-0 space-y-4">
          {mode === 'existing' ? (
            <label className="block min-w-0 text-xs font-medium text-muted-foreground">
              全局模型
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
                  全局 models 中还没有可用模型
                </span>
              )}
            </label>
          ) : (
            <div className="min-w-0 max-w-full overflow-hidden rounded-md border border-dashed p-4">
              <p className="text-sm font-medium">选择模型入口文件</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                支持 *.model3.json 与 *.model.json。入口所在的完整目录会复制到全局 models。
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                disabled={submitting}
                onClick={(): void => void chooseModelEntry()}
              >
                选择入口文件
              </Button>
              {sourcePath && (
                <p
                  className="mt-3 block w-full min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px] text-muted-foreground"
                  title={sourcePath}
                >
                  {fileNameFromPath(sourcePath)}
                </p>
              )}
            </div>
          )}

          <label className="block min-w-0 text-xs font-medium text-muted-foreground">
            显示名称（可选）
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
              高级选项
            </summary>
            <div className="border-t px-3 py-3">
              <label className="block text-xs font-medium text-muted-foreground">
                项目资源键
                <Input
                  value={key}
                  disabled={submitting}
                  placeholder="留空自动生成"
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
            取消
          </Button>
          <Button
            type="button"
            disabled={submitting || (mode === 'existing' ? !modelId : !sourcePath)}
            onClick={(): void => void submit()}
          >
            {submitting ? '处理中…' : mode === 'existing' ? '加入项目' : '导入并加入'}
          </Button>
        </DialogFooter>
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
    throw new Error(`项目 metadata.json 不存在: ${projectName}`)
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

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}
