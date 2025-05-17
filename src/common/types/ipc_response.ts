import { Story } from './story'

export interface SelectStoryResponse {
  success: boolean
  path?: string
  data?: Story
  zodIssueMessage?: string
  error?: unknown
}
