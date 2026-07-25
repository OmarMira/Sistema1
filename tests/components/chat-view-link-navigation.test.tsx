// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatView } from '@/components/assistant/ChatView';

afterEach(() => cleanup());

const mockLangState = { t: (key: string) => key, language: 'en' };
vi.mock('@/store/language-store', () => ({
  useLanguageStore: Object.assign(
    (selector: (s: any) => any) => selector(mockLangState),
    { getState: () => mockLangState },
  ),
}));

const setCurrentView = vi.fn();
const setAiAssistantOpen = vi.fn();
const setSettingsActiveTab = vi.fn();

vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector: (s: any) => any) =>
    selector({
      setCurrentView,
      setAiAssistantOpen,
      setSettingsActiveTab,
    }),
}));

function createMessage(content: string) {
  return [{ id: 'test-msg', role: 'assistant' as const, content, timestamp: new Date() }];
}

const defaultProps = {
  isLoading: false,
  error: '',
  chatInput: '',
  setChatInput: vi.fn(),
  handleChatSubmit: vi.fn(),
  handleChatKeyDown: vi.fn(),
  chatScrollRef: { current: null } as React.RefObject<HTMLDivElement | null>,
  chatInputRef: { current: null } as React.RefObject<HTMLTextAreaElement | null>,
  handleStartWizard: vi.fn(),
  wizardOpen: false,
  setWizardOpen: vi.fn(),
  wizardCode: '',
  setWizardCode: vi.fn(),
  wizardName: '',
  setWizardName: vi.fn(),
  handleSaveWizardAccount: vi.fn(),
};

describe('ChatView — internal link navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clicking [Configurar IA](/settings) calls setSettingsActiveTab + setCurrentView + setAiAssistantOpen', async () => {
    const messages = createMessage('[Configurar IA](/settings)');
    render(<ChatView {...defaultProps} messages={messages} />);

    const link = screen.getByText('Configurar IA');
    expect(link).toBeInTheDocument();

    await userEvent.click(link);

    expect(setSettingsActiveTab).toHaveBeenCalledWith('ai-config');
    expect(setCurrentView).toHaveBeenCalledWith('settings');
    expect(setAiAssistantOpen).toHaveBeenCalledWith(false);
  });

  it('clicking [/dashboard] does NOT call setSettingsActiveTab', async () => {
    const messages = createMessage('[Go to Dashboard](/dashboard)');
    render(<ChatView {...defaultProps} messages={messages} />);

    const link = screen.getByText('Go to Dashboard');
    expect(link).toBeInTheDocument();

    await userEvent.click(link);

    expect(setSettingsActiveTab).not.toHaveBeenCalled();
    expect(setCurrentView).toHaveBeenCalledWith('dashboard');
    expect(setAiAssistantOpen).toHaveBeenCalledWith(false);
  });

  it('parseMessageContent renders external links as <a> with target=_blank', () => {
    const messages = createMessage('[OpenAI](https://openai.com)');
    render(<ChatView {...defaultProps} messages={messages} />);

    const link = screen.getByText('OpenAI');
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', 'https://openai.com');
    expect(link).toHaveAttribute('target', '_blank');
  });
});
