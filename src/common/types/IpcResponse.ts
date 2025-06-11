import { StoryData } from './Story'

export interface SelectStoryResponse {
  success: boolean
  path?: string
  data?: StoryData
  zodIssueMessage?: string
  error?: unknown
}
