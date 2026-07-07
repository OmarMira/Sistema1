// Type declarations for packages that don't ship bundled type definitions
// or are missing from the current node_modules installation.

declare module '@radix-ui/react-accordion' {
  import React from 'react';
  export const Root: React.FC<{ type?: 'single' | 'multiple'; collapsible?: boolean; defaultValue?: string[]; value?: string[]; onValueChange?: (value: string[]) => void; children?: React.ReactNode; className?: string ; [key: string]: unknown }>;
  export const Item: React.FC<{ value: string; disabled?: boolean; children?: React.ReactNode; className?: string ; [key: string]: unknown }>;
  export const Header: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Trigger: React.FC<{ children?: React.ReactNode; className?: string ; [key: string]: unknown }>;
  export const Content: React.FC<{ children?: React.ReactNode; className?: string ; [key: string]: unknown }>;
}

declare module '@radix-ui/react-alert-dialog' {
  import React from 'react';
  export const Root: React.FC<{ open?: boolean; onOpenChange?: (open: boolean) => void; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Trigger: React.FC<{ asChild?: boolean; children?: React.ReactNode; className?: string ; [key: string]: unknown }>;
  export const Portal: React.FC<{ children?: React.ReactNode ; [key: string]: unknown }>;
  export const Overlay: React.FC<{ className?: string ; [key: string]: unknown }>;
  export const Content: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Title: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Description: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Cancel: React.FC<{ asChild?: boolean; className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Action: React.FC<{ asChild?: boolean; className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
}

declare module '@radix-ui/react-aspect-ratio' {
  import React from 'react';
  export const Root: React.FC<{ ratio?: number; children?: React.ReactNode; className?: string ; [key: string]: unknown }>;
}

declare module '@radix-ui/react-avatar' {
  import React from 'react';
  export const Root: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Image: React.FC<{ src?: string; alt?: string; className?: string ; [key: string]: unknown }>;
  export const Fallback: React.FC<{ className?: string; children?: React.ReactNode; delayMs?: number ; [key: string]: unknown }>;
}

declare module '@radix-ui/react-checkbox' {
  import React from 'react';
  export const Root: React.FC<{ checked?: boolean | 'indeterminate'; onCheckedChange?: (checked: boolean | 'indeterminate') => void; disabled?: boolean; className?: string; id?: string; name?: string; required?: boolean; children?: React.ReactNode; [key: string]: unknown }>;
  export const Indicator: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
}

declare module '@radix-ui/react-collapsible' {
  import React from 'react';
  export const Root: React.FC<{ open?: boolean; onOpenChange?: (open: boolean) => void; disabled?: boolean; className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Trigger: React.FC<{ asChild?: boolean; className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const CollapsibleTrigger: React.FC<{ asChild?: boolean; className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Content: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const CollapsibleContent: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
}

declare module '@radix-ui/react-context-menu' {
  import React from 'react';
  export const Root: React.FC<{ children?: React.ReactNode ; [key: string]: unknown }>;
  export const Trigger: React.FC<{ asChild?: boolean; children?: React.ReactNode; className?: string ; [key: string]: unknown }>;
  export const Portal: React.FC<{ children?: React.ReactNode ; [key: string]: unknown }>;
  export const Content: React.FC<{ className?: string; children?: React.ReactNode; side?: string; align?: string; alignOffset?: number; sideOffset?: number ; [key: string]: unknown }>;
  export const Group: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Sub: React.FC<{ children?: React.ReactNode ; [key: string]: unknown }>;
  export const Item: React.FC<{ className?: string; children?: React.ReactNode; disabled?: boolean; onSelect?: () => void; onClick?: () => void ; [key: string]: unknown }>;
  export const ItemIndicator: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Separator: React.FC<{ className?: string ; [key: string]: unknown }>;
  export const Label: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const CheckboxItem: React.FC<{ checked?: boolean; onCheckedChange?: (checked: boolean) => void; className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const RadioGroup: React.FC<{ value?: string; onValueChange?: (value: string) => void; children?: React.ReactNode ; [key: string]: unknown }>;
  export const RadioItem: React.FC<{ value: string; className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const SubTrigger: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const SubContent: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
}

declare module '@radix-ui/react-dialog' {
  import React from 'react';
  export const Root: React.FC<{ open?: boolean; onOpenChange?: (open: boolean) => void; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Trigger: React.FC<{ asChild?: boolean; children?: React.ReactNode; className?: string ; [key: string]: unknown }>;
  export const Portal: React.FC<{ children?: React.ReactNode ; [key: string]: unknown }>;
  export const Overlay: React.FC<{ className?: string ; [key: string]: unknown }>;
  export const Content: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Title: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Description: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Close: React.FC<{ asChild?: boolean; className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
}

declare module '@radix-ui/react-dropdown-menu' {
  import React from 'react';
  export const Root: React.FC<{ children?: React.ReactNode ; [key: string]: unknown }>;
  export const Trigger: React.FC<{ asChild?: boolean; children?: React.ReactNode; className?: string ; [key: string]: unknown }>;
  export const Portal: React.FC<{ children?: React.ReactNode ; [key: string]: unknown }>;
  export const Content: React.FC<{ className?: string; children?: React.ReactNode; side?: string; align?: string; alignOffset?: number; sideOffset?: number ; [key: string]: unknown }>;
  export const Group: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Sub: React.FC<{ children?: React.ReactNode ; [key: string]: unknown }>;
  export const Item: React.FC<{ className?: string; children?: React.ReactNode; disabled?: boolean; onSelect?: () => void; onClick?: () => void ; [key: string]: unknown }>;
  export const ItemIndicator: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Separator: React.FC<{ className?: string ; [key: string]: unknown }>;
  export const Label: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const CheckboxItem: React.FC<{ checked?: boolean; onCheckedChange?: (checked: boolean) => void; className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const RadioGroup: React.FC<{ value?: string; onValueChange?: (value: string) => void; children?: React.ReactNode ; [key: string]: unknown }>;
  export const RadioItem: React.FC<{ value: string; className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const SubTrigger: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const SubContent: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
}

declare module '@radix-ui/react-hover-card' {
  import React from 'react';
  export const Root: React.FC<{ openDelay?: number; closeDelay?: number; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Trigger: React.FC<{ asChild?: boolean; children?: React.ReactNode; className?: string ; [key: string]: unknown }>;
  export const Portal: React.FC<{ children?: React.ReactNode ; [key: string]: unknown }>;
  export const Content: React.FC<{ className?: string; children?: React.ReactNode; side?: string; align?: string; sideOffset?: number; alignOffset?: number ; [key: string]: unknown }>;
}

declare module '@radix-ui/react-label' {
  import React from 'react';
  export const Root: React.FC<{ htmlFor?: string; className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
}

declare module '@radix-ui/react-menubar' {
  import React from 'react';
  export const Root: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Menu: React.FC<{ children?: React.ReactNode ; [key: string]: unknown }>;
  export const Trigger: React.FC<{ asChild?: boolean; className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Portal: React.FC<{ children?: React.ReactNode ; [key: string]: unknown }>;
  export const Content: React.FC<{ className?: string; children?: React.ReactNode; side?: string; align?: string; alignOffset?: number; sideOffset?: number ; [key: string]: unknown }>;
  export const Group: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const RadioGroup: React.FC<{ value?: string; onValueChange?: (value: string) => void; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Sub: React.FC<{ children?: React.ReactNode ; [key: string]: unknown }>;
  export const Item: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const ItemIndicator: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const CheckboxItem: React.FC<{ checked?: boolean; onCheckedChange?: (checked: boolean) => void; className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const RadioItem: React.FC<{ value: string; className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Separator: React.FC<{ className?: string ; [key: string]: unknown }>;
  export const Label: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const SubTrigger: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const SubContent: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
}

declare module '@radix-ui/react-navigation-menu' {
  import React from 'react';
  export const Root: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const List: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Item: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Link: React.FC<{ className?: string; children?: React.ReactNode; active?: boolean; onSelect?: () => void ; [key: string]: unknown }>;
  export const Trigger: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Content: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Indicator: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Viewport: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
}

declare module '@radix-ui/react-popover' {
  import React from 'react';
  export const Root: React.FC<{ open?: boolean; onOpenChange?: (open: boolean) => void; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Trigger: React.FC<{ asChild?: boolean; children?: React.ReactNode; className?: string ; [key: string]: unknown }>;
  export const Portal: React.FC<{ children?: React.ReactNode ; [key: string]: unknown }>;
  export const Content: React.FC<{ className?: string; children?: React.ReactNode; side?: string; align?: string; sideOffset?: number; alignOffset?: number ; [key: string]: unknown }>;
  export const Anchor: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
}

declare module '@radix-ui/react-progress' {
  import React from 'react';
  export const Root: React.FC<{ value?: number; max?: number; className?: string; children?: React.ReactNode; [key: string]: unknown }>;
  export const Indicator: React.FC<{ className?: string; style?: React.CSSProperties ; [key: string]: unknown }>;
}

declare module '@radix-ui/react-radio-group' {
  import React from 'react';
  export const Root: React.FC<{ value?: string; onValueChange?: (value: string) => void; disabled?: boolean; className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Item: React.FC<{ value: string; disabled?: boolean; className?: string; id?: string; children?: React.ReactNode; [key: string]: unknown }>;
  export const Indicator: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
}

declare module '@radix-ui/react-scroll-area' {
  import React from 'react';
  export const Root: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Viewport: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Scrollbar: React.FC<{ orientation: 'horizontal' | 'vertical'; className?: string ; [key: string]: unknown }>;
  export const ScrollAreaScrollbar: React.FC<{ orientation?: 'horizontal' | 'vertical'; className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Thumb: React.FC<{ className?: string ; [key: string]: unknown }>;
  export const ScrollAreaThumb: React.FC<{ className?: string ; [key: string]: unknown }>;
  export const Corner: React.FC<{ className?: string ; [key: string]: unknown }>;
}

declare module '@radix-ui/react-select' {
  import React from 'react';
  export const Root: React.FC<{ value?: string; onValueChange?: (value: string) => void; defaultValue?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Trigger: React.FC<{ className?: string; children?: React.ReactNode; asChild?: boolean ; [key: string]: unknown }>;
  export const Value: React.FC<{ placeholder?: string ; [key: string]: unknown }>;
  export const Icon: React.FC<{ className?: string; children?: React.ReactNode; asChild?: boolean ; [key: string]: unknown }>;
  export const Portal: React.FC<{ children?: React.ReactNode ; [key: string]: unknown }>;
  export const Content: React.FC<{ className?: string; children?: React.ReactNode; position?: 'item-aligned' | 'popper' ; [key: string]: unknown }>;
  export const ScrollUpButton: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const ScrollDownButton: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Viewport: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Item: React.FC<{ value: string; disabled?: boolean; className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const ItemText: React.FC<{ children?: React.ReactNode ; [key: string]: unknown }>;
  export const ItemIndicator: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Label: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Separator: React.FC<{ className?: string ; [key: string]: unknown }>;
  export const Group: React.FC<{ children?: React.ReactNode ; [key: string]: unknown }>;
}

declare module '@radix-ui/react-separator' {
  import React from 'react';
  export const Root: React.FC<{ orientation?: 'horizontal' | 'vertical'; decorative?: boolean; className?: string ; [key: string]: unknown }>;
}

declare module '@radix-ui/react-slider' {
  import React from 'react';
  export const Root: React.FC<{ value?: number[]; onValueChange?: (value: number[]) => void; defaultValue?: number[]; min?: number; max?: number; step?: number; className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Track: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Range: React.FC<{ className?: string ; [key: string]: unknown }>;
  export const Thumb: React.FC<{ className?: string ; [key: string]: unknown }>;
}

declare module '@radix-ui/react-switch' {
  import React from 'react';
  export const Root: React.FC<{ checked?: boolean; onCheckedChange?: (checked: boolean) => void; disabled?: boolean; className?: string; id?: string; children?: React.ReactNode; [key: string]: unknown }>;
  export const Thumb: React.FC<{ className?: string ; [key: string]: unknown }>;
}

declare module '@radix-ui/react-tabs' {
  import React from 'react';
  export const Root: React.FC<{ value?: string; onValueChange?: (value: string) => void; defaultValue?: string; className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const List: React.FC<{ className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Trigger: React.FC<{ value: string; disabled?: boolean; className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Content: React.FC<{ value: string; className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
}

declare module '@radix-ui/react-toast' {
  import React from 'react';

  // ForwardRefExoticComponent-compatible patterns
  interface ToastRootProps { open?: boolean; onOpenChange?: (open: boolean) => void; className?: string; children?: React.ReactNode; duration?: number; }
  interface ToastProviderProps { children?: React.ReactNode; duration?: number; }
  interface ToastViewportProps { className?: string; ref?: React.Ref<unknown>; children?: React.ReactNode; }
  interface ToastTitleProps { className?: string; children?: React.ReactNode; }
  interface ToastDescriptionProps { className?: string; children?: React.ReactNode; }
  interface ToastActionProps { asChild?: boolean; className?: string; children?: React.ReactNode; altText: string; }
  interface ToastCloseProps { asChild?: boolean; className?: string; children?: React.ReactNode; }

  export const Provider: React.FC<ToastProviderProps>;
  export const Viewport: React.ForwardRefExoticComponent<ToastViewportProps & React.RefAttributes<unknown>>;
  export const Root: React.ForwardRefExoticComponent<ToastRootProps & React.RefAttributes<unknown>>;
  export const Title: React.ForwardRefExoticComponent<ToastTitleProps & React.RefAttributes<unknown>>;
  export const Description: React.ForwardRefExoticComponent<ToastDescriptionProps & React.RefAttributes<unknown>>;
  export const Action: React.ForwardRefExoticComponent<ToastActionProps & React.RefAttributes<unknown>>;
  export const Close: React.ForwardRefExoticComponent<ToastCloseProps & React.RefAttributes<unknown>>;
}

declare module '@radix-ui/react-toggle' {
  import React from 'react';
  export const Root: React.FC<{ pressed?: boolean; onPressedChange?: (pressed: boolean) => void; className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
}

declare module '@radix-ui/react-toggle-group' {
  import React from 'react';
  export const Root: React.FC<{ type?: 'single' | 'multiple'; value?: string; onValueChange?: (value: string) => void; className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Item: React.FC<{ value: string; className?: string; children?: React.ReactNode ; [key: string]: unknown }>;
}

declare module '@radix-ui/react-tooltip' {
  import React from 'react';
  export const Provider: React.FC<{ delayDuration?: number; skipDelayDuration?: number; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Root: React.FC<{ open?: boolean; onOpenChange?: (open: boolean) => void; defaultOpen?: boolean; delayDuration?: number; children?: React.ReactNode ; [key: string]: unknown }>;
  export const Trigger: React.FC<{ asChild?: boolean; children?: React.ReactNode; className?: string ; [key: string]: unknown }>;
  export const Portal: React.FC<{ children?: React.ReactNode ; [key: string]: unknown }>;
  export const Content: React.FC<{ className?: string; children?: React.ReactNode; side?: string; align?: string; sideOffset?: number; alignOffset?: number ; [key: string]: unknown }>;
  export const Arrow: React.FC<{ className?: string ; [key: string]: unknown }>;
}

declare module '@radix-ui/react-slot' {
  import React from 'react';
  export const Slot: React.FC<{ children?: React.ReactNode; className?: string; [key: string]: unknown }>;
  export const Slottable: React.FC<{ children?: React.ReactNode ; [key: string]: unknown }>;
}

declare module '@testing-library/user-event' {
  import { type PointerInput, type KeyboardInput } from '@testing-library/dom';
  interface UserOptions {
    delay?: number;
    pointerMap?: PointerInput[];
    advanceTimers?: () => Promise<void> | void;
  }
  interface UserInstance {
    click: (element: Element) => Promise<void>;
    dblClick: (element: Element) => Promise<void>;
    type: (element: Element, text: string, options?: { delay?: number }) => Promise<void>;
    clear: (element: Element) => Promise<void>;
    selectOptions: (element: Element, values: string | string[]) => Promise<void>;
    keyboard: (text: string) => Promise<void>;
    pointer: (input: PointerInput) => Promise<void>;
    tab: (options?: { shift?: boolean }) => Promise<void>;
    hover: (element: Element) => Promise<void>;
    unhover: (element: Element) => Promise<void>;
    upload: (element: Element, files: File | File[]) => Promise<void>;
    paste: (element: Element, data: string) => Promise<void>;
  }
  const userEvent: {
    setup: (options?: UserOptions) => UserInstance;
    click: (element: Element) => Promise<void>;
    dblClick: (element: Element) => Promise<void>;
    type: (element: Element, text: string, options?: { delay?: number }) => Promise<void>;
    clear: (element: Element) => Promise<void>;
    selectOptions: (element: Element, values: string | string[]) => Promise<void>;
    keyboard: (text: string) => Promise<void>;
    pointer: (input: PointerInput) => Promise<void>;
    tab: (options?: { shift?: boolean }) => Promise<void>;
    hover: (element: Element) => Promise<void>;
    unhover: (element: Element) => Promise<void>;
  };
  export default userEvent;
}

declare module '@tanstack/react-query' {
  import React from 'react';
  export interface QueryClientConfig {
    defaultOptions?: {
      queries?: {
        staleTime?: number;
        retry?: number | boolean;
        refetchOnWindowFocus?: boolean;
        enabled?: boolean;
      };
    };
  }
  export class QueryClient {
    constructor(config?: QueryClientConfig);
    isFetching(): number;
    invalidateQueries(options?: { queryKey?: unknown[] }): Promise<void>;
    setQueryData<T = unknown>(queryKey: unknown[], data: T): void;
    getQueryData<T = unknown>(queryKey: unknown[]): T | undefined;
    clear(): void;
    removeQueries(options?: { queryKey?: unknown[] }): void;
  }
  export interface QueryObserverResult<TData = unknown, TError = unknown> {
    data: TData | undefined;
    error: TError | null;
    isLoading: boolean;
    isFetching: boolean;
    isError: boolean;
    isSuccess: boolean;
    isStale: boolean;
    status: 'idle' | 'loading' | 'success' | 'error';
    dataUpdatedAt: number;
    errorUpdatedAt: number;
    failureCount: number;
    errorUpdateCount: number;
    refetch: () => Promise<QueryObserverResult<TData, TError>>;
  }
  export function useQuery<TData = unknown, TError = unknown>(options: {
    queryKey: unknown[];
    queryFn: () => Promise<TData> | TData;
    enabled?: boolean;
    staleTime?: number;
    gcTime?: number;
    retry?: number | boolean;
    refetchOnWindowFocus?: boolean;
    refetchInterval?: number | false;
    select?: (data: TData) => unknown;
  }): QueryObserverResult<TData, TError>;
  export function useMutation<TData = unknown, TError = unknown, TVariables = unknown>(options: {
    mutationFn: (variables: TVariables) => Promise<TData> | TData;
    onSuccess?: (data: TData, variables: TVariables) => void;
    onError?: (error: TError, variables: TVariables) => void;
    onSettled?: (data: TData | undefined, error: TError | null, variables: TVariables) => void;
  }): {
    mutate: (variables: TVariables) => void;
    mutateAsync: (variables: TVariables) => Promise<TData>;
    isLoading: boolean;
    isPending: boolean;
    isError: boolean;
    isSuccess: boolean;
    data: TData | undefined;
    error: TError | null;
    reset: () => void;
  };
  export function useQueryClient(): QueryClient;
  export const QueryClientProvider: React.FC<{ client: QueryClient; children?: React.ReactNode ; [key: string]: unknown }>;
}

declare module '@tanstack/react-virtual' {
  import React from 'react';
  export interface VirtualItem {
    key: string;
    index: number;
    start: number;
    end: number;
    size: number;
  }
  export interface VirtualizerOptions {
    count: number;
    getScrollElement: () => HTMLElement | null;
    estimateSize?: (index: number) => number;
    overscan?: number;
    paddingStart?: number;
    paddingEnd?: number;
  }
  export function useVirtualizer(options: VirtualizerOptions): {
    getVirtualItems: () => VirtualItem[];
    getTotalSize: () => number;
    scrollToIndex: (index: number) => void;
    scrollToOffset: (offset: number) => void;
  };
}

declare module '@testing-library/react' {
  import React from 'react';
  export interface RenderOptions {
    container?: HTMLElement;
    baseElement?: HTMLElement;
    hydrate?: boolean;
    wrapper?: React.ComponentType<{ children?: React.ReactNode }>;
  }
  export interface RenderResult {
    container: HTMLElement;
    baseElement: HTMLElement;
    debug: (el?: HTMLElement) => void;
    rerender: (ui: React.ReactElement) => void;
    unmount: () => void;
    asFragment: () => DocumentFragment;
  }
  export function render(ui: React.ReactElement, options?: RenderOptions): RenderResult;
  export function cleanup(): void;
  export interface Screen {
    getByText: (text: string | RegExp) => HTMLElement;
    getByTestId: (id: string) => HTMLElement;
    getByRole: (role: string, options?: { name?: string | RegExp }) => HTMLElement;
    getByLabelText: (text: string | RegExp) => HTMLElement;
    getByPlaceholderText: (text: string | RegExp) => HTMLElement;
    getAllByPlaceholderText: (text: string | RegExp) => HTMLElement[];
    queryByText: (text: string | RegExp) => HTMLElement | null;
    queryByTestId: (id: string) => HTMLElement | null;
    queryByPlaceholderText: (text: string | RegExp) => HTMLElement | null;
    queryAllByText: (text: string | RegExp) => HTMLElement[];
    findByText: (text: string | RegExp) => Promise<HTMLElement>;
    findByTestId: (id: string) => Promise<HTMLElement>;
    findByRole: (role: string, options?: { name?: string | RegExp }) => Promise<HTMLElement>;
    findByPlaceholderText: (text: string | RegExp) => Promise<HTMLElement>;
    getAllByText: (text: string | RegExp) => HTMLElement[];
    getAllByRole: (role: string, options?: { name?: string | RegExp }) => HTMLElement[];
    getAllByTestId: (id: string) => HTMLElement[];
  }
  export const screen: Screen;
  export function waitFor<T = void>(callback: () => T | Promise<T>, options?: { timeout?: number; interval?: number }): Promise<T>;
  export function act(callback: () => void): void;
  export interface FireEventObject {
    (element: HTMLElement, event?: Event): void;
    click: (element: HTMLElement, options?: object) => void;
    change: (element: HTMLElement, options?: { target?: { value?: string } }) => void;
    submit: (element: HTMLElement) => void;
    keyDown: (element: HTMLElement, options?: { key?: string }) => void;
  }
  export const fireEvent: FireEventObject;
}

declare module '@testing-library/jest-dom/vitest' {
  export {};
}

declare module 'lucide-react' {
  import React from 'react';
  export type IconNode = [element: string, attrs: Record<string, string>][];
  export type Icon = React.FC<React.SVGAttributes<SVGSVGElement> & { className?: string; size?: number | string }>;

  // Dynamic icon access — allows any icon name
  export const createLucideIcon: (name: string, iconNode: IconNode) => Icon;

  // Commonly used icons (explicit for autocomplete)
  export const X: Icon;
  export const ChevronDown: Icon;
  export const ChevronUp: Icon;
  export const Check: Icon;
  export const CheckIcon: Icon;
  export const Menu: Icon;
  export const Search: Icon;
  export const SearchIcon: Icon;
  export const Plus: Icon;
  export const Minus: Icon;
  export const Trash: Icon;
  export const Trash2: Icon;
  export const Edit: Icon;
  export const Pencil: Icon;
  export const AlertCircle: Icon;
  export const AlertTriangle: Icon;
  export const CheckCircle: Icon;
  export const Info: Icon;
  export const InfoIcon: Icon;
  export const Loader: Icon;
  export const Loader2: Icon;
  export const RefreshCw: Icon;
  export const Save: Icon;
  export const Download: Icon;
  export const Upload: Icon;
  export const FileText: Icon;
  export const FileSpreadsheet: Icon;
  export const Folder: Icon;
  export const MoreHorizontal: Icon;
  export const MoreVertical: Icon;
  export const ArrowDown: Icon;
  export const ArrowUp: Icon;
  export const ArrowLeft: Icon;
  export const ArrowRight: Icon;
  export const ChevronsUpDown: Icon;
  export const Eye: Icon;
  export const EyeOff: Icon;
  export const Lock: Icon;
  export const Unlock: Icon;
  export const Mail: Icon;
  export const Calendar: Icon;
  export const Clock: Icon;
  export const Bell: Icon;
  export const Book: Icon;
  export const Building: Icon;
  export const Building2: Icon;
  export const CreditCard: Icon;
  export const DollarSign: Icon;
  export const BarChart: Icon;
  export const BarChart3: Icon;
  export const PieChart: Icon;
  export const TrendingUp: Icon;
  export const TrendingDown: Icon;
  export const Activity: Icon;
  export const Filter: Icon;
  export const List: Icon;
  export const Table: Icon;
  export const Columns: Icon;
  export const ExternalLink: Icon;
  export const Link: Icon;
  export const Link2: Icon;
  export const Copy: Icon;
  export const Printer: Icon;
  export const Send: Icon;
  export const Share: Icon;
  export const HelpCircle: Icon;
  export const Circle: Icon;
  export const Square: Icon;
  export const CheckSquare: Icon;
  export const Sun: Icon;
  export const Moon: Icon;
  export const Star: Icon;
  export const Heart: Icon;
  export const ThumbsUp: Icon;
  export const ThumbsDown: Icon;
  export const MessageCircle: Icon;
  export const MessageSquare: Icon;
  export const Flag: Icon;
  export const Tag: Icon;
  export const Shield: Icon;
  export const ShieldAlert: Icon;
  export const ShieldCheck: Icon;
  export const Database: Icon;
  export const Server: Icon;
  export const Wifi: Icon;
  export const Power: Icon;
  export const Play: Icon;
  export const Pause: Icon;
  export const RotateCw: Icon;
  export const Sparkles: Icon;
  export const Zap: Icon;
  export const Globe: Icon;
  export const Home: Icon;
  export const Inbox: Icon;
  export const LogOut: Icon;
  export const LogIn: Icon;
  export const Key: Icon;
  export const Camera: Icon;
  export const Image: Icon;
  export const Palette: Icon;
  export const ZoomIn: Icon;
  export const ZoomOut: Icon;
  export const History: Icon;
  export const Timer: Icon;
  export const Box: Icon;
  export const Package: Icon;
  export const Archive: Icon;
  export const Layers: Icon;
  export const Bot: Icon;
  export const Brain: Icon;
  export const Lightbulb: Icon;
  export const Puzzle: Icon;
  export const Landmark: Icon;
  export const Receipt: Icon;
  export const Scroll: Icon;
  export const File: Icon;
  export const Pen: Icon;
  export const PenLine: Icon;
  export const Terminal: Icon;
  export const Code: Icon;
  export const Container: Icon;
  export const Navigation: Icon;
  export const Navigation2: Icon;
  export const Compass: Icon;
  export const Map: Icon;
  export const Target: Icon;
  export const Crosshair: Icon;
  export const Mic: Icon;
  export const Volume: Icon;
  export const Headphones: Icon;
  export const Monitor: Icon;
  export const Smartphone: Icon;
  export const Watch: Icon;
  export const Wallet: Icon;
  export const Crown: Icon;
  export const Swords: Icon;
  export const ScrollText: Icon;
  export const Undo2: Icon;
  export const PlusCircle: Icon;
  export const MinusCircle: Icon;
  export const XCircle: Icon;
  export const Ban: Icon;
  export const Bug: Icon;
  export const CalendarDays: Icon;
  export const ArrowDownToLine: Icon;
  export const ArrowUpDown: Icon;
  export const ArrowRightLeft: Icon;
  export const ArrowLeftRight: Icon;
  export const GripVertical: Icon;
  export const Handshake: Icon;
  export const NotebookPen: Icon;
  export const BotMessageSquare: Icon;
  export const CircleDot: Icon;
  export const UserPlus: Icon;
  export const ChartNoAxesColumnIncreasing: Icon;
  export const ChartNoAxesCombined: Icon;
  export const ChartArea: Icon;
  export const ChartBar: Icon;
  export const ChartPie: Icon;
  export const ChartLine: Icon;
  export const HardDrive: Icon;
  export const CircleIcon: Icon;
  export const ChevronRightIcon: Icon;
  export const ChevronLeftIcon: Icon;
  export const MinusIcon: Icon;
  export const XIcon: Icon;
  export const MoreHorizontalIcon: Icon;
  export const GripVerticalIcon: Icon;
  export const PanelLeftIcon: Icon;
  export const ChevronDownIcon: Icon;
  export const ChevronUpIcon: Icon;

  // Allow any string-indexed access — covers icons not explicitly listed
  export function createElement(tag: string): Icon;

  // Additional icon exports
  export const ArrowUpRight: Icon;
  export const ArrowDownRight: Icon;
  export const ChevronRight: Icon;
  export const FolderOpen: Icon;
  export const PowerOff: Icon;
  export const ChevronLeft: Icon;
  export const LayoutDashboard: Icon;
  export const FilePlus2: Icon;
  export const CheckCircle2: Icon;
  export const UserPlus: Icon;
  export const Users: Icon;
  export const Wallet: Icon;
  export const Crown: Icon;
  export const CircleDot: Icon;
  export const XCircle: Icon;
  export const BookOpen: Icon;
  export const CalendarDays: Icon;
  export const ArrowDownToLine: Icon;
  export const BotMessageSquare: Icon;
  export const MapPin: Icon;
  export const Phone: Icon;
  export const SlidersHorizontal: Icon;
  export const GripHorizontal: Icon;
  export const Undo2: Icon;
  export const NotepadText: Icon;
  export const UserCheck: Icon;
  export const UserMinus: Icon;
  export const Settings: Icon;
  export const Cpu: Icon;
  export const DatabaseBackup: Icon;
  export const FileJson: Icon;
  export const RotateCcw: Icon;
  export const RefreshCcw: Icon;
  export const FileUp: Icon;
  export const SendHorizontal: Icon;
  export const FileCheck: Icon;
  export const KeyRound: Icon;
  export const Scissors: Icon;
  export const ClipboardList: Icon;
  export const Sliders: Icon;
  export const CheckCheck: Icon;
  export const PlayCircle: Icon;
  export const Scale: Icon;
  export const Rows3: Icon;
  export const Columns3: Icon;
  export const Pilcrow: Icon;
  export const PilcrowLeft: Icon;
  export const PilcrowRight: Icon;
  export const SquareUser: Icon;
  export const SquareUserRound: Icon;
  export const CircleUser: Icon;
  export const CircleUserRound: Icon;
  export const Activity: Icon;
  export const WalletCards: Icon;
  export const ArrowBigUp: Icon;
  export const ArrowBigDown: Icon;
  export const ArrowBigLeft: Icon;
  export const ArrowBigRight: Icon;
  export const ArrowUpFromLine: Icon;
  export const ArrowDownFromLine: Icon;
  export const Contact: Icon;
  export const User: Icon;
}

// Vitest custom matchers from @testing-library/jest-dom
interface Assertion<T = unknown> {
  toBeInTheDocument(): void;
  toBeDisabled(): void;
  toHaveValue(value?: string | number | null): void;
  toHaveTextContent(text: string | RegExp): void;
  toBeVisible(): void;
  toBeEmpty(): void;
  toBeEnabled(): void;
  toBeChecked(): void;
  toHaveClass(...classNames: string[]): void;
  toHaveAttribute(attr: string, value?: string): void;
  toHaveFocus(): void;
  toContainElement(element: HTMLElement | null): void;
  toContainHTML(htmlText: string): void;
  toHaveStyle(css: Record<string, unknown> | string): void;
}
