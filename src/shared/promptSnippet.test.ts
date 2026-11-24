import { describe, expect, it } from 'vitest'
import { promptSnippet } from './promptSnippet'

describe('promptSnippet', () => {
  it('names the asset and includes the spec and code', () => {
    const text = promptSnippet({ name: 'glass-nav-hover', specMarkdown: '# Glass nav\n', html: '<p>x</p>' })
    expect(text).toContain('"glass-nav-hover"')
    expect(text).toContain('## Spec\n\n# Glass nav')
    expect(text).toContain('```html\n<p>x</p>\n```')
  })

  it('works before analysis, with only the name', () => {
    expect(promptSnippet({ name: 'card', specMarkdown: null, html: null })).not.toContain('##')
  })
})
