import * as WebBrowser from 'expo-web-browser';
import type { Nodes, Parent, PhrasingContent, RootContent } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { Fragment, type ReactNode, useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { Text } from './text';
import { makeStyles, radius, space, type TypeRole, type, useTheme } from './theme';

/** A link agents wrote, if it may be opened: http(s) only, as on the web. */
export function safeUrl(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function openLink(url: string): void {
  void WebBrowser.openBrowserAsync(url).catch(() => {
    // No browser to show it in: nothing more to do from here.
  });
}

/**
 * Markdown from agents (reports, briefs, messages), drawn with the app's own components. Parsed as on
 * the web (mdast with GFM), so both show the same thing. Raw HTML is dropped, links work only when
 * they're http(s) and open in the in-app browser, and images show as links ("[alt]").
 */
export function Markdown({ children, variant = 'body' }: { children: string; variant?: TypeRole }) {
  const styles = useStyles();
  const tree = useMemo(
    () => fromMarkdown(children, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }),
    [children],
  );
  return <View style={styles.root}>{blocks(tree.children, variant, styles)}</View>;
}

type Styles = ReturnType<typeof useStyles>;

/** A node's key: where it starts in the text, which no other node shares. */
const at = (node: Nodes, fallback: number): string => String(node.position?.start.offset ?? `i${fallback}`);

function blocks(nodes: readonly RootContent[], role: TypeRole, styles: Styles): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${node.type}-${index}`;
    switch (node.type) {
      case 'paragraph':
        return (
          <Text key={key} variant={role}>
            {inline(node.children)}
          </Text>
        );
      case 'heading':
        return (
          <Text
            key={key}
            variant={node.depth === 1 ? 'title' : node.depth === 2 ? 'heading' : 'label'}
            accessibilityRole="header"
            style={styles.heading}
          >
            {inline(node.children)}
          </Text>
        );
      case 'code':
        return (
          <ScrollView key={key} horizontal style={styles.code} contentContainerStyle={styles.codeContent}>
            <Text variant="mono" selectable>
              {node.value}
            </Text>
          </ScrollView>
        );
      case 'blockquote':
        return (
          <View key={key} style={styles.quote}>
            {blocks(node.children, role, styles)}
          </View>
        );
      case 'list':
        return (
          <View key={key} accessibilityRole="list" style={styles.list}>
            {node.children.map((item, itemIndex) => (
              <View key={at(item, itemIndex)} style={styles.item}>
                <Text variant={role} color="mutedForeground" style={styles.marker}>
                  {item.checked === true
                    ? '☑'
                    : item.checked === false
                      ? '☐'
                      : node.ordered
                        ? `${(node.start ?? 1) + itemIndex}.`
                        : '•'}
                </Text>
                <View style={styles.itemBody}>{blocks(item.children, role, styles)}</View>
              </View>
            ))}
          </View>
        );
      case 'thematicBreak':
        return <View key={key} style={styles.rule} />;
      case 'table':
        return (
          <ScrollView key={key} horizontal contentContainerStyle={styles.table}>
            <View>
              {node.children.map((row, rowIndex) => (
                <View key={at(row, rowIndex)} style={[styles.tableRow, rowIndex === 0 && styles.tableHead]}>
                  {row.children.map((cell, cellIndex) => (
                    <Text
                      key={at(cell, cellIndex)}
                      variant={rowIndex === 0 ? 'label' : 'bodySmall'}
                      style={styles.cell}
                    >
                      {inline(cell.children)}
                    </Text>
                  ))}
                </View>
              ))}
            </View>
          </ScrollView>
        );
      case 'html':
        // Raw HTML from an agent is never rendered.
        return null;
      default:
        return 'children' in node ? (
          <Fragment key={key}>{blocks((node as Parent).children as RootContent[], role, styles)}</Fragment>
        ) : null;
    }
  });
}

function inline(nodes: readonly PhrasingContent[] | readonly Nodes[]): ReactNode[] {
  return (nodes as readonly Nodes[]).map((node, index) => {
    const key = `${node.type}-${index}`;
    switch (node.type) {
      case 'text':
        return node.value;
      case 'strong':
        return (
          <Text key={key} style={{ fontFamily: 'MonaSans-SemiBold' }}>
            {inline(node.children)}
          </Text>
        );
      case 'emphasis':
        return (
          <Text key={key} style={{ fontStyle: 'italic' }}>
            {inline(node.children)}
          </Text>
        );
      case 'delete':
        return (
          <Text key={key} style={{ textDecorationLine: 'line-through' }}>
            {inline(node.children)}
          </Text>
        );
      case 'inlineCode':
        return <InlineCode key={key}>{node.value}</InlineCode>;
      case 'break':
        return '\n';
      case 'link': {
        const url = safeUrl(node.url);
        return url ? (
          <LinkText key={key} url={url}>
            {inline(node.children)}
          </LinkText>
        ) : (
          <Text key={key}>{inline(node.children)}</Text>
        );
      }
      case 'image': {
        const url = safeUrl(node.url);
        const label = `[${node.alt || 'image'}]`;
        return url ? (
          <LinkText key={key} url={url}>
            {label}
          </LinkText>
        ) : (
          label
        );
      }
      case 'html':
        return null;
      default:
        return 'children' in node ? (
          <Fragment key={key}>{inline((node as Parent).children as Nodes[])}</Fragment>
        ) : null;
    }
  });
}

function LinkText({ url, children }: { url: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <Text
      accessibilityRole="link"
      accessibilityHint={`Opens ${new URL(url).host}`}
      onPress={() => openLink(url)}
      style={{ color: theme.colors.foreground, textDecorationLine: 'underline' }}
    >
      {children}
    </Text>
  );
}

function InlineCode({ children }: { children: string }) {
  const theme = useTheme();
  return (
    <Text
      style={{ fontFamily: type.mono.fontFamily, backgroundColor: theme.colors.fill }}
    >{` ${children} `}</Text>
  );
}

const useStyles = makeStyles((theme) => ({
  root: { gap: space.md },
  heading: { marginTop: space.xs },
  code: {
    backgroundColor: theme.colors.fillSubtle,
    borderRadius: radius.md,
    boxShadow: `inset 0 0 0 1px ${theme.colors.surfaceRim}`,
  },
  codeContent: { padding: space.md },
  quote: {
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.borderStrong,
    paddingLeft: space.md,
    gap: space.sm,
  },
  list: { gap: space.xs },
  item: { flexDirection: 'row', gap: space.sm },
  marker: { minWidth: 18 },
  itemBody: { flex: 1, gap: space.xs },
  rule: { height: 1, backgroundColor: theme.colors.border, marginVertical: space.xs },
  table: { paddingBottom: space.xs },
  tableRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  tableHead: { borderBottomColor: theme.colors.borderStrong },
  cell: { minWidth: 96, maxWidth: 240, paddingVertical: space.sm, paddingRight: space.lg },
}));
