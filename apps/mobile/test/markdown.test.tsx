import { describe, expect, it } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Markdown } from '../src/ui/markdown';
import { ThemeProvider } from '../src/ui/theme';
import { browser } from './device';

const show = (text: string) =>
  render(
    <ThemeProvider>
      <Markdown>{text}</Markdown>
    </ThemeProvider>,
  );

describe('markdown from agents', () => {
  it('draws headings, lists, emphasis and code', async () => {
    await show(
      '## Findings\n\n1. **Observational memory** works\n2. Retrieval `needs` embeddings\n\n- [x] Done',
    );
    expect(screen.getByRole('header')).toHaveTextContent('Findings');
    expect(screen.getByText('Observational memory')).toBeOnTheScreen();
    expect(screen.getByText(/needs/)).toBeOnTheScreen();
    expect(screen.getByText('☑')).toBeOnTheScreen();
  });

  it('never renders raw HTML', async () => {
    await show('Before\n\n<script>alert(1)</script>\n\n<b>bold?</b> after');
    expect(screen.queryByText(/alert/)).toBeNull();
    expect(screen.queryByText(/<b>/)).toBeNull();
    expect(screen.getByText(/after/)).toBeOnTheScreen();
  });

  it('opens http(s) links in the in-app browser, and no others', async () => {
    await show(
      '[the paper](https://example.com/paper) and [a trap](javascript:alert(1)) and ![chart](https://example.com/c.png)',
    );
    await fireEvent.press(screen.getByRole('link', { name: 'the paper' }));
    expect(browser.openBrowserAsync).toHaveBeenCalledWith('https://example.com/paper');
    // The javascript: link is plain text; the image is a link to it, never fetched.
    expect(screen.queryByRole('link', { name: 'a trap' })).toBeNull();
    expect(screen.getByText(/a trap/)).toBeOnTheScreen();
    expect(screen.getByRole('link', { name: '[chart]' })).toBeOnTheScreen();
  });
});
