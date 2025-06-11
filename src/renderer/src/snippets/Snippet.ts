import { SnippetData } from '../../../common/types/Story'

export interface Snippet {
  handleSnippet(data: SnippetData): Promise<void>
}
