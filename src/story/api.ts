import { invoke } from '@tauri-apps/api/core'
import { StorySchema, type StoryData, type StoryInput } from './schema'

export async function getProjectStory(projectName: string): Promise<StoryData> {
  const raw = await invoke<unknown>('get_project_story', { projectName })
  return StorySchema.parse(raw)
}

export function setProjectStory(projectName: string, story: StoryInput): Promise<void> {
  return invoke('set_project_story', { projectName, story })
}
