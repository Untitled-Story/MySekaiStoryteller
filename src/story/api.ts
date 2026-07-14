import { invoke } from '@tauri-apps/api/core'
import { StorySchema, type StoryData, type StoryInput } from './schema'

export async function getProjectStory(projectName: string): Promise<StoryData> {
  const raw = await invoke<unknown>('get_project_story', { projectName })
  return StorySchema.parse(raw)
}

export async function setProjectStory(projectName: string, story: StoryInput): Promise<void> {
  const validatedStory: StoryData = StorySchema.parse(story)
  await invoke('set_project_story', { projectName, story: validatedStory })
}
