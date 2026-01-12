import { describe, it, expect } from 'vitest';

// Copy the function to test it directly
function truncateHtml(html: string, maxLength: number): string {
  if (html.length <= maxLength) return html;
  
  let truncated = html.substring(0, maxLength - 20);
  
  // Remove any incomplete tag at the end
  const lastOpenTag = truncated.lastIndexOf('<');
  const lastCloseTag = truncated.lastIndexOf('>');
  
  if (lastOpenTag > lastCloseTag) {
    truncated = truncated.substring(0, lastOpenTag);
  }
  
  // Close any open tags
  const openTags: string[] = [];
  const tagRegex = /<\/?([a-zA-Z]+)[^>]*>/g;
  let match;
  
  while ((match = tagRegex.exec(truncated)) !== null) {
    const [fullMatch, tagName] = match;
    if (fullMatch.startsWith('</')) {
      const idx = openTags.lastIndexOf(tagName.toLowerCase());
      if (idx !== -1) openTags.splice(idx, 1);
    } else if (!fullMatch.endsWith('/>')) {
      openTags.push(tagName.toLowerCase());
    }
  }
  
  let result = truncated + '\n...[Truncated]';
  for (let i = openTags.length - 1; i >= 0; i--) {
    result += `</${openTags[i]}>`;
  }
  
  return result;
}

describe('truncateHtml', () => {
  it('returns original if under limit', () => {
    const html = '<b>Short</b>';
    expect(truncateHtml(html, 100)).toBe(html);
  });

  it('truncates and closes open tags', () => {
    const html = '<b>Hello <i>world this is a very long message that needs truncation</i></b>';
    const result = truncateHtml(html, 50);
    expect(result).toContain('...[Truncated]');
    expect(result).toContain('</b>');
    // Should not have unclosed tags
    expect(result.match(/<b>/g)?.length).toBe(result.match(/<\/b>/g)?.length);
  });

  it('removes incomplete tags at end', () => {
    const html = '<b>Hello</b> <a href="http://example.com">Link</a>';
    const result = truncateHtml(html, 40);
    // Should not end with incomplete tag like <a href="...
    expect(result).not.toMatch(/<[^>]*$/);
  });

  it('handles nested tags', () => {
    const html = '<b><i><a href="test">Deep nesting here with lots of content</a></i></b>';
    const result = truncateHtml(html, 50);
    // Count opening and closing tags
    const opens = (result.match(/<[a-z]+[^>]*>/g) || []).length;
    const closes = (result.match(/<\/[a-z]+>/g) || []).length;
    expect(opens).toBe(closes);
  });

  it('handles real Telegram message with links', () => {
    const html = `<b>Found 20 New Job Matches!</b>
<i>Backend Engineer · Remote</i>

<b>1. Senior Software Engineer</b>
   Company Inc | 85 pts
   Remote | USD 150,000 - 200,000
   <a href="https://example.com/apply1">Apply</a>

<b>2. Backend Developer</b>
   Another Corp | 80 pts
   New York | USD 120,000 - 160,000
   <a href="https://example.com/apply2">Indeed</a> | <a href="https://linkedin.com/job2">LinkedIn</a>`;
    
    const result = truncateHtml(html, 300);
    expect(result).toContain('...[Truncated]');
    // Verify no unclosed tags - simple check: count < and > after escaping
    expect(() => {
      // This would throw if HTML is malformed in a real parser
      const opens = (result.match(/<[a-z]+[^>]*>/gi) || []).length;
      const closes = (result.match(/<\/[a-z]+>/gi) || []).length;
      if (opens !== closes) throw new Error('Mismatched tags');
    }).not.toThrow();
  });
});
