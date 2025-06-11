import { Story } from './Story'

export interface SelectStoryResponse {
  success: boolean
  path?: string
  data?: Story
  zodIssueMessage?: string
  error?: unknown
}
