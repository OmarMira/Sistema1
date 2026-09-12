// TX-REVIEW-UI-001 — Import entry point tests (T19–T21)
// ImportResultDialog exposes the review action when uncategorized > 0,
// hides it when there is nothing to review, and navigates to the review dialog.

// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImportResultDialog } from '../../src/components/import/ImportResultDialog';

afterEach(() => {
  cleanup();
});

const tFn = vi.fn((key: string) => key);
vi.mock('@/store/language-store', () => ({
  useLanguageStore: (selector: (s: any) => any) => selector({ t: tFn }),
}));

function renderDialog(opts: {
  transactionCount: number;
  autoCategorizedCount: number;
  onReviewUncategorized: () => void;
}) {
  return render(
    <ImportResultDialog
      open={true}
      onOpenChange={vi.fn()}
      result={{
        statementId: 'stmt-1',
        transactionCount: opts.transactionCount,
        autoCategorizedCount: opts.autoCategorizedCount,
        duplicatesSkipped: 0,
      } as never}
      onClassifyEntities={vi.fn()}
      onGoToReconciliation={vi.fn()}
      onReviewUncategorized={opts.onReviewUncategorized}
    />,
  );
}

describe('TX-REVIEW-UI-001 — ImportResultDialog entry point (T19–T21)', () => {
  it('T19: uncategorized > 0 shows the review action', () => {
    renderDialog({ transactionCount: 10, autoCategorizedCount: 7, onReviewUncategorized: vi.fn() });
    expect(screen.getByTestId('review-uncategorized-btn')).toBeInTheDocument();
  });

  it('T20: uncategorized = 0 does not show the action', () => {
    renderDialog({ transactionCount: 10, autoCategorizedCount: 10, onReviewUncategorized: vi.fn() });
    expect(screen.queryByTestId('review-uncategorized-btn')).not.toBeInTheDocument();
  });

  it('T21: the action triggers the review navigation callback', async () => {
    const onReview = vi.fn();
    const user = userEvent.setup();
    renderDialog({ transactionCount: 5, autoCategorizedCount: 2, onReviewUncategorized: onReview });
    await user.click(screen.getByTestId('review-uncategorized-btn'));
    expect(onReview).toHaveBeenCalledOnce();
  });
});
