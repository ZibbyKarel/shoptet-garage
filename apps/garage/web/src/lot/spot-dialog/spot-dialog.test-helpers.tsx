/**
 * Shared fixtures and the render harness for every `SpotDialog` spec file —
 * split out so `spot-dialog-failures.spec.tsx` (which mocks `next-intl`, see
 * its own header comment) can reuse the exact same render tree as
 * `spot-dialog.spec.tsx` (which does not) without duplicating it.
 */
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from '@garage/i18n';
import cs from '../../../messages/cs.json';
import { SpotDialog } from './spot-dialog';
import { ToastProvider } from '../../shell/notifications/toast-provider';
import type { SpotView } from '../lot-view';

export function spot(overrides: Partial<SpotView> = {}): SpotView {
  return {
    spotId: 'spot-a',
    label: 'E2.92',
    appearance: 'free',
    action: 'reserve',
    holderName: null,
    holderPlate: null,
    carColorClass: null,
    editorName: null,
    waitlistCount: 0,
    isMine: false,
    viewerWaitlistEntryId: null,
    viewerWaitlistPosition: null,
    showAdminMenu: false,
    hidden: false,
    evCharger: false,
    holderIsGuest: false,
    infoReason: null,
    timedBlocks: [],
    ...overrides,
  };
}

export const takenByOther = spot({
  appearance: 'taken',
  action: 'queue',
  holderName: 'Petr Novák',
  holderPlate: '8SC 9012',
  carColorClass: 'text-car-2',
});

export const mine = spot({
  appearance: 'taken',
  action: 'mine',
  isMine: true,
  holderName: 'Karel Zíbar',
  holderPlate: '4AB 1234',
  carColorClass: 'text-car-3',
});

export interface DialogOverrides {
  spot?: SpotView | null;
  canReserve?: boolean;
  isAdmin?: boolean;
  error?: unknown;
  errorMessage?: string;
  viewerUserId?: string | null;
  holderOptions?: readonly { userId: string; name: string; licensePlate: string | null }[];
  holderPending?: boolean;
  queueTargetOptions?: readonly { userId: string; name: string; licensePlate: string | null }[];
  queueTargetPending?: boolean;
}

export function renderDialog(overrides: DialogOverrides = {}) {
  const callbacks = {
    onClose: jest.fn(),
    onReserve: jest.fn(),
    onJoinWaitlist: jest.fn(),
    onLeaveWaitlist: jest.fn(),
    onCancelReservation: jest.fn(),
    onReserveTimed: jest.fn(),
    onCancelTimedReservation: jest.fn(),
  };

  function tree(props: DialogOverrides) {
    return (
      <IntlProvider locale="cs" messages={cs}>
        <ToastProvider>
          <SpotDialog
            spot={props.spot === undefined ? spot() : props.spot}
            date="2026-09-28"
            canReserve={props.canReserve ?? true}
            isAdmin={props.isAdmin ?? false}
            monthName="září"
            error={props.error ?? null}
            {...(props.errorMessage === undefined ? {} : { errorMessage: props.errorMessage })}
            pending={false}
            viewerUserId={props.viewerUserId ?? null}
            holderOptions={props.holderOptions ?? []}
            holderPending={props.holderPending ?? false}
            queueTargetOptions={props.queueTargetOptions ?? []}
            queueTargetPending={props.queueTargetPending ?? false}
            {...callbacks}
          />
        </ToastProvider>
      </IntlProvider>
    );
  }

  const { rerender } = render(tree(overrides));

  return {
    ...callbacks,
    user: userEvent.setup(),
    /**
     * Re-renders with `next` merged over the props this call was made with —
     * the same component instance, which is the point: it is how a prop that
     * arrives *after* mount (a profile query resolving, a second bay opening)
     * gets exercised at all.
     */
    rerender: (next: DialogOverrides) => rerender(tree({ ...overrides, ...next })),
  };
}
