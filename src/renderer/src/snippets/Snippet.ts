import { SnippetData } from '../../../common/types/Story'

export interface Snippet {
  runSnippet(snippet: SnippetData): Promise<void>
  handleSnippet(): Promise<void>
}
