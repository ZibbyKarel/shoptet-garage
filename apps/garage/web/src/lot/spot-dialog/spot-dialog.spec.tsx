import { screen } from '@testing-library/react';
import { mine, renderDialog, spot, takenByOther } from './spot-dialog.test-helpers';
import { GUEST_HOLDER_VALUE } from './holder-input';

/**
 * Which actions the dialog offers, in which state.
 *
 * These are the assertions that pin the reservation-window rules the brief is
 * strictest about: a normal user in a month they may not book must not be
 * offered a way to book it, but must keep the way out of what they already
 * have. Both halves are checked, in both directions.
 */

describe('SpotDialog', () => {
  it('renders nothing when no bay is open', () => {
    renderDialog({ spot: null });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('names the bay in the eyebrow', () => {
    renderDialog();
    expect(screen.getByText('modalEyebrow: label=E2.92')).toBeInTheDocument();
  });

  /**
   * `showCancel`/`showPrimary` are read off three genuinely independent
   * props (`spot`, `canReserve`, `isAdmin` — see the module docs) rather than
   * off a value this component derives once and reuses. Every other test
   * here passes them a *consistent* combination, the one `toSpotView` would
   * actually produce, which cannot tell `showCancel`'s `isTaken` conjunct or
   * `showPrimary`'s `!isInfo` conjunct apart from the rest of the expression:
   * both are measured to fail 0 tests when deleted from a suite that only
   * ever sees consistent props. These two exercise the inconsistent
   * combinations a future reuse (Task 31's bulk flow is the obvious
   * candidate) could pass by accident.
   */
  it('does not offer cancelling on a free bay, even to an admin', () => {
    renderDialog({ spot: spot({ appearance: 'free', action: 'reserve' }), isAdmin: true });
    expect(screen.queryByRole('button', { name: 'cancelReservation' })).not.toBeInTheDocument();
  });

  it('never offers reserving from the explanatory dialog, whatever canReserve says', () => {
    renderDialog({
      spot: spot({ appearance: 'window-locked', action: 'info' }),
      canReserve: true,
    });
    expect(screen.queryByRole('button', { name: 'ctaReserve' })).not.toBeInTheDocument();
  });
});

describe('SpotDialog — a free bay', () => {
  it('offers reserving it', async () => {
    const { onReserve, user } = renderDialog();

    expect(screen.getByRole('heading', { name: 'titleReserve' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'ctaReserve' }));
    expect(onReserve).toHaveBeenCalledTimes(1);
  });

  it('explains rather than offering, in a month the caller may not book', () => {
    renderDialog({
      spot: spot({ appearance: 'window-locked', action: 'info' }),
      canReserve: false,
    });

    expect(screen.getByRole('heading', { name: 'titleInfo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ctaReserve' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'close' })).toBeInTheDocument();
  });

  it('explains that the viewer already holds a reservation elsewhere that day, distinctly from a locked month', () => {
    renderDialog({
      spot: spot({ appearance: 'free', action: 'info', infoReason: 'already-reserved' }),
      canReserve: true,
    });

    expect(screen.getByRole('heading', { name: 'titleInfoAlreadyReserved' })).toBeInTheDocument();
    expect(screen.getByText('subInfoAlreadyReserved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ctaReserve' })).not.toBeInTheDocument();
  });
});

describe('SpotDialog — a bay somebody else holds', () => {
  it('shows the holder and the queue, and offers joining it', async () => {
    const { onJoinWaitlist, user } = renderDialog({
      spot: { ...takenByOther, waitlistCount: 2 },
    });

    expect(screen.getByText('Petr Novák')).toBeInTheDocument();
    expect(screen.getByText('occupiedBy: plate=8SC 9012')).toBeInTheDocument();
    expect(screen.getByText('queueHeading')).toBeInTheDocument();
    expect(screen.getByText('waiting: count=2')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'ctaQueue' }));
    expect(onJoinWaitlist).toHaveBeenCalledTimes(1);
  });

  it('hides the queue section from a normal user when nobody is waiting', () => {
    renderDialog({ spot: takenByOther });
    expect(screen.queryByText('queueHeading')).not.toBeInTheDocument();
    expect(screen.queryByText('queueEmpty')).not.toBeInTheDocument();
  });

  it('tells a queued caller where they stand, and offers leaving', async () => {
    const { onLeaveWaitlist, user } = renderDialog({
      spot: {
        ...takenByOther,
        waitlistCount: 3,
        viewerWaitlistEntryId: 'wait-7',
        viewerWaitlistPosition: 2,
      },
    });

    expect(screen.getByText('queuePosition: position=2')).toBeInTheDocument();
    // Joining a queue you are already in is `ALREADY_IN_WAITLIST`, so the two
    // actions are alternatives rather than both being offered.
    expect(screen.queryByRole('button', { name: 'ctaQueue' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'leaveQueue' }));
    expect(onLeaveWaitlist).toHaveBeenCalledTimes(1);
  });

  // Found by running the screen in a browser against the real API: the heading
  // read "Přidat se do fronty" above a button reading "Odejít z fronty".
  it('does not head a queued caller’s modal with an invitation to join', () => {
    renderDialog({
      spot: { ...takenByOther, waitlistCount: 1, viewerWaitlistEntryId: 'wait-7' },
    });

    expect(screen.getByRole('heading', { name: 'titleQueued' })).toBeInTheDocument();
    expect(screen.getByText('subQueued')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'titleQueue' })).not.toBeInTheDocument();
  });

  it('says the same to a queued admin, whose cancel button is unaffected', () => {
    renderDialog({
      spot: { ...takenByOther, waitlistCount: 1, viewerWaitlistEntryId: 'wait-7' },
      isAdmin: true,
    });

    expect(screen.getByRole('heading', { name: 'titleQueued' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'cancelReservation' })).toBeInTheDocument();
  });

  it('still invites a caller who is not queued to join', () => {
    renderDialog({ spot: takenByOther });
    expect(screen.getByRole('heading', { name: 'titleQueue' })).toBeInTheDocument();
  });

  it('hides joining, and shows the yellow note, in a locked month', () => {
    renderDialog({ spot: takenByOther, canReserve: false });

    expect(screen.queryByRole('button', { name: 'ctaQueue' })).not.toBeInTheDocument();
    expect(screen.getByText('lockNote: month=září')).toBeInTheDocument();
  });

  it('does not offer a normal user the cancel button on somebody else’s spot', () => {
    renderDialog({ spot: takenByOther });
    expect(screen.queryByRole('button', { name: 'cancelReservation' })).not.toBeInTheDocument();
  });

  it('does offer an admin the cancel button on somebody else’s spot', async () => {
    const { onCancelReservation, user } = renderDialog({ spot: takenByOther, isAdmin: true });

    await user.click(screen.getByRole('button', { name: 'cancelReservation' }));
    expect(onCancelReservation).toHaveBeenCalledTimes(1);
  });

  it('keeps an admin’s cancel button in a locked month', () => {
    // `reservation.cancel` declares no window errors at all: "a locked window
    // stops people from taking spots, not from giving them back."
    renderDialog({ spot: takenByOther, isAdmin: true, canReserve: false });
    expect(screen.getByRole('button', { name: 'cancelReservation' })).toBeInTheDocument();
  });
});

describe('SpotDialog — the caller’s own reservation', () => {
  it('offers cancelling and nothing else', async () => {
    const { onCancelReservation, onJoinWaitlist, user } = renderDialog({ spot: mine });

    expect(screen.getByRole('heading', { name: 'titleMine' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ctaQueue' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'cancelReservation' }));
    expect(onCancelReservation).toHaveBeenCalledTimes(1);
    expect(onJoinWaitlist).not.toHaveBeenCalled();
  });

  it('keeps cancelling available in a locked month, and says so', () => {
    // The brief's rule, and the contract's: `Zrušit rezervaci` stays available
    // to the holder whatever the window is doing.
    renderDialog({ spot: mine, canReserve: false });

    expect(screen.getByRole('button', { name: 'cancelReservation' })).toBeEnabled();
    expect(screen.getByText('subMineLocked')).toBeInTheDocument();
  });
});

const OPTIONS = [
  { userId: 'admin-1', name: 'Dev Admin', licensePlate: '1AA 1111' },
  { userId: 'user-2', name: 'Jana Nováková', licensePlate: null },
];

describe('SpotDialog — an admin reserving a free bay', () => {
  function renderAdmin(overrides: Parameters<typeof renderDialog>[0] = {}) {
    return renderDialog({
      isAdmin: true,
      viewerUserId: 'admin-1',
      holderOptions: OPTIONS,
      ...overrides,
    });
  }

  it('offers the holder selector, with the admin themselves preselected', async () => {
    renderAdmin();

    const select = screen.getByLabelText('holderField');
    expect(select).toHaveValue('admin-1');
    expect(screen.getByRole('option', { name: 'holderGuestOption' })).toBeInTheDocument();
    // With a plate on file, the option label carries it too — the whole point
    // of a selector that was meant to show "jméno i spz". Without one (Jana
    // Nováková, below), the label is the bare name.
    expect(screen.getByRole('option', { name: 'Dev Admin — 1AA 1111' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Jana Nováková' })).toBeInTheDocument();
  });

  it('reserves for the admin themselves on a single click, with no plate override', async () => {
    // The browser suite's `reserveSpot` does exactly this — opens the dialog
    // and clicks once (`apps/garage/web-e2e/src/support/lot-page.ts:122-125`) — so a
    // form that needed a selection first would take that journey red.
    const { onReserve, user } = renderAdmin();

    await user.click(screen.getByRole('button', { name: 'ctaReserve' }));

    expect(onReserve).toHaveBeenCalledTimes(1);
    expect(onReserve).toHaveBeenCalledWith({
      kind: 'USER',
      userId: 'admin-1',
      licensePlate: null,
    });
  });

  it('reserves for another user, with the plate the admin typed', async () => {
    const { onReserve, user } = renderAdmin();

    await user.selectOptions(screen.getByLabelText('holderField'), 'user-2');
    await user.type(screen.getByLabelText('plateField'), '9XY 8765');
    await user.click(screen.getByRole('button', { name: 'ctaReserve' }));

    expect(onReserve).toHaveBeenCalledWith({
      kind: 'USER',
      userId: 'user-2',
      licensePlate: '9XY 8765',
    });
  });

  it('hints the chosen holder’s stored plate, so blank is not a blank plate', async () => {
    const { user } = renderAdmin();
    const plate = screen.getByLabelText('plateField');

    expect(plate).toHaveAttribute('placeholder', '1AA 1111');
    await user.selectOptions(screen.getByLabelText('holderField'), 'user-2');
    expect(plate).toHaveAttribute('placeholder', 'noPlate');
  });

  it('asks for a guest’s name, and refuses to submit without one', async () => {
    const { onReserve, user } = renderAdmin();

    await user.selectOptions(screen.getByLabelText('holderField'), 'GUEST');
    await user.click(screen.getByRole('button', { name: 'ctaReserve' }));

    expect(onReserve).not.toHaveBeenCalled();
    expect(await screen.findByText('guestNameRequired')).toBeInTheDocument();

    await user.type(screen.getByLabelText('guestNameField'), 'Jan Host');
    await user.click(screen.getByRole('button', { name: 'ctaReserve' }));

    expect(onReserve).toHaveBeenCalledWith({
      kind: 'GUEST',
      name: 'Jan Host',
      licensePlate: null,
    });
  });

  /**
   * These two are the only tests that exercise the `form.reset` effect
   * (`spot-dialog.tsx:133-139`). Measured: with the `form.reset(...)` call
   * deleted, the rest of this file's 671 tests still pass and only these two
   * fail — which is what a test of a defensive branch is for.
   */
  it('seeds the holder once the viewer id arrives after the dialog was opened', async () => {
    const { onReserve, user, rerender } = renderAdmin({ viewerUserId: null });

    // No `viewerUserId` yet, so the plain self-book path is on screen.
    expect(screen.queryByLabelText('holderField')).not.toBeInTheDocument();

    rerender({ viewerUserId: 'admin-1' });

    expect(screen.getByLabelText('holderField')).toHaveValue('admin-1');
    await user.click(screen.getByRole('button', { name: 'ctaReserve' }));
    expect(onReserve).toHaveBeenCalledWith({
      kind: 'USER',
      userId: 'admin-1',
      licensePlate: null,
    });
  });

  it('does not carry a guest name from one bay into the next', async () => {
    const { user, rerender } = renderAdmin();

    await user.selectOptions(screen.getByLabelText('holderField'), 'GUEST');
    await user.type(screen.getByLabelText('guestNameField'), 'Jan Host');

    rerender({ spot: spot({ spotId: 'spot-b', label: 'E2.93' }) });

    expect(screen.getByLabelText('holderField')).toHaveValue('admin-1');
    expect(screen.queryByLabelText('guestNameField')).not.toBeInTheDocument();
  });

  it('disables Rezervovat while the holder list is still loading, instead of silently booking for the admin', () => {
    // While `admin.user.list` is in flight, `holderOptions` is empty and
    // `showHolderForm` is false — the same shape as a normal user's dialog.
    // Without `holderPending`, one click here would call `onReserve()` with no
    // argument and book the bay for the admin, with no selector ever shown.
    renderAdmin({ holderOptions: [], holderPending: true });

    expect(screen.getByRole('button', { name: 'ctaReserve' })).toBeDisabled();
  });

  it('offers a guest half-hour block, and submits it through onReserveTimed rather than onReserve', async () => {
    const { onReserve, onReserveTimed, user } = renderAdmin();

    await user.selectOptions(screen.getByLabelText('holderField'), GUEST_HOLDER_VALUE);
    await user.type(screen.getByLabelText('guestNameField'), 'Jan Host');
    // No duration select yet — the whole-day / block choice.
    expect(screen.queryByLabelText('startTimeField')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('durationField'), 'TIMED');
    expect(screen.getByLabelText('startTimeField')).toBeInTheDocument();
    expect(screen.getByLabelText('endTimeField')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('startTimeField'), '09:00');
    await user.selectOptions(screen.getByLabelText('endTimeField'), '10:30');
    await user.click(screen.getByRole('button', { name: 'ctaReserve' }));

    expect(onReserveTimed).toHaveBeenCalledWith({
      guestName: 'Jan Host',
      licensePlate: null,
      startTime: '09:00',
      endTime: '10:30',
    });
    expect(onReserve).not.toHaveBeenCalled();
  });

  it('refuses to submit a guest block whose end is not later than its start', async () => {
    const { onReserveTimed, user } = renderAdmin();

    await user.selectOptions(screen.getByLabelText('holderField'), GUEST_HOLDER_VALUE);
    await user.type(screen.getByLabelText('guestNameField'), 'Jan Host');
    await user.selectOptions(screen.getByLabelText('durationField'), 'TIMED');
    await user.selectOptions(screen.getByLabelText('startTimeField'), '10:00');
    await user.selectOptions(screen.getByLabelText('endTimeField'), '09:30');
    await user.click(screen.getByRole('button', { name: 'ctaReserve' }));

    expect(onReserveTimed).not.toHaveBeenCalled();
    expect(await screen.findByText('timeRangeInvalid')).toBeInTheDocument();
  });
});

describe('SpotDialog — a timed spot’s guest blocks', () => {
  const BLOCKS = [
    {
      id: 'block-1',
      startTime: '09:00',
      endTime: '10:30',
      guestName: 'Jan Host',
      licensePlate: null,
      createdAt: '2026-09-01T00:00:00.000Z',
    },
    {
      id: 'block-2',
      startTime: '13:00',
      endTime: '14:00',
      guestName: 'Eva Malá',
      licensePlate: '5CD 4321',
      createdAt: '2026-09-01T00:00:00.000Z',
    },
  ];

  it('lets an admin book another block and cancel an existing one', async () => {
    const { onCancelTimedReservation, onReserveTimed, user } = renderDialog({
      spot: spot({
        appearance: 'timed',
        action: 'reserve',
        timedBlocks: BLOCKS,
      }),
      isAdmin: true,
      viewerUserId: 'admin-1',
      holderOptions: [{ userId: 'admin-1', name: 'Dev Admin', licensePlate: '1AA 1111' }],
    });

    // The holder is a fixed guest — no selector, no duration choice.
    expect(screen.queryByLabelText('holderField')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('durationField')).not.toBeInTheDocument();
    expect(screen.getByLabelText('guestNameField')).toBeInTheDocument();
    expect(screen.getByLabelText('startTimeField')).toBeInTheDocument();

    expect(screen.getByText('timedBlocksHeading')).toBeInTheDocument();
    expect(screen.getByText('9:00–10:30')).toBeInTheDocument();
    expect(screen.getByText('Jan Host')).toBeInTheDocument();
    expect(screen.getByText('13:00–14:00')).toBeInTheDocument();
    expect(screen.getByText('Eva Malá')).toBeInTheDocument();

    const cancelButtons = screen.getAllByRole('button', { name: 'timedBlockCancel' });
    expect(cancelButtons).toHaveLength(2);
    await user.click(cancelButtons[0] as HTMLElement);
    expect(onCancelTimedReservation).toHaveBeenCalledWith('block-1');

    await user.type(screen.getByLabelText('guestNameField'), 'Petr Nový');
    await user.selectOptions(screen.getByLabelText('startTimeField'), '11:00');
    await user.selectOptions(screen.getByLabelText('endTimeField'), '11:30');
    await user.click(screen.getByRole('button', { name: 'ctaReserve' }));

    expect(onReserveTimed).toHaveBeenCalledWith({
      guestName: 'Petr Nový',
      licensePlate: null,
      startTime: '11:00',
      endTime: '11:30',
    });
  });

  it('shows the list to a non-admin, with no cancel button', () => {
    renderDialog({
      spot: spot({
        appearance: 'timed',
        action: 'info',
        infoReason: 'timed',
        timedBlocks: BLOCKS,
      }),
    });

    expect(screen.getByText('infoTimedBlocks')).toBeInTheDocument();
    expect(screen.getByText('timedBlocksHeading')).toBeInTheDocument();
    expect(screen.getByText('9:00–10:30')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'timedBlockCancel' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('guestNameField')).not.toBeInTheDocument();
  });
});

describe('SpotDialog — a normal user reserving a free bay', () => {
  it('sees no holder selector and reserves for themselves', async () => {
    const { onReserve, user } = renderDialog({ viewerUserId: 'user-2', holderOptions: [] });

    expect(screen.queryByLabelText('holderField')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'ctaReserve' }));

    // No argument at all: an omitted holder is "the caller", which is what the
    // contract's optional `holder` was shaped for.
    expect(onReserve).toHaveBeenCalledWith();
  });
});

describe('SpotDialog — a bay a guest holds', () => {
  it('says so beside the name', () => {
    renderDialog({
      spot: spot({
        appearance: 'taken',
        action: 'queue',
        holderName: 'Jan Novotný',
        holderPlate: null,
        holderIsGuest: true,
        carColorClass: 'text-fg-3',
      }),
    });

    expect(screen.getByText('Jan Novotný')).toBeInTheDocument();
    expect(screen.getByText('guestHolder')).toBeInTheDocument();
  });
});

describe('SpotDialog — a taken bay whose holder has no plate on file', () => {
  it('omits the plate line instead of saying it is missing', () => {
    renderDialog({
      spot: spot({
        appearance: 'taken',
        action: 'queue',
        holderName: 'Petr Novák',
        holderPlate: null,
        carColorClass: 'text-car-2',
      }),
    });

    expect(screen.getByText('Petr Novák')).toBeInTheDocument();
    expect(screen.queryByText('noPlate')).not.toBeInTheDocument();
    expect(screen.queryByText(/obsazeno/)).not.toBeInTheDocument();
  });
});

const QUEUE_OPTIONS = [
  { userId: 'admin-1', name: 'Dev Admin', licensePlate: '1AA 1111' },
  { userId: 'user-2', name: 'Jana Nováková', licensePlate: null },
];

describe('SpotDialog — an admin adding somebody to the queue', () => {
  function renderAdminQueue(overrides: Parameters<typeof renderDialog>[0] = {}) {
    return renderDialog({
      spot: takenByOther,
      isAdmin: true,
      viewerUserId: 'admin-1',
      queueTargetOptions: QUEUE_OPTIONS,
      ...overrides,
    });
  }

  it('still shows the queue heading to an admin when nobody is waiting, with a selector', () => {
    renderAdminQueue();

    expect(screen.getByText('queueHeading')).toBeInTheDocument();
    expect(screen.getByText('queueEmpty')).toBeInTheDocument();
    expect(screen.getByLabelText('queueHolderField')).toHaveValue('admin-1');
    expect(screen.getByRole('option', { name: 'Jana Nováková' })).toBeInTheDocument();
  });

  it('joins the admin themselves on a single click, with no selection required', async () => {
    const { onJoinWaitlist, user } = renderAdminQueue();

    await user.click(screen.getByRole('button', { name: 'ctaQueue' }));

    expect(onJoinWaitlist).toHaveBeenCalledTimes(1);
    expect(onJoinWaitlist).toHaveBeenCalledWith('admin-1');
  });

  it('adds the selected user instead, when the admin picks somebody else', async () => {
    const { onJoinWaitlist, user } = renderAdminQueue();

    await user.selectOptions(screen.getByLabelText('queueHolderField'), 'user-2');
    await user.click(screen.getByRole('button', { name: 'ctaQueue' }));

    expect(onJoinWaitlist).toHaveBeenCalledWith('user-2');
  });

  it('does not offer the selector once the admin is already queued', () => {
    renderAdminQueue({
      spot: { ...takenByOther, viewerWaitlistEntryId: 'wait-7' },
    });

    expect(screen.queryByLabelText('queueHolderField')).not.toBeInTheDocument();
  });

  it('defaults to the first eligible user instead of the admin themselves, when the admin already holds a reservation that day and is excluded from the filtered list', async () => {
    // `queueTargetOptions` is already filtered server-side
    // (`excludingReservedOrQueuedFor`) — an admin who already holds a
    // reservation that day is not in it, even though `viewerUserId` still
    // names them. Defaulting to `viewerUserId` regardless would leave the
    // `<select>` showing no option selected while the form still held the
    // excluded id, so a submit would send it straight into
    // `RESERVATION_LIMIT_REACHED` — the exact post-submission failure this
    // filtered list exists to prevent up front.
    const { onJoinWaitlist, user } = renderAdminQueue({ viewerUserId: 'admin-9' });

    expect(screen.getByLabelText('queueHolderField')).toHaveValue('admin-1');

    await user.click(screen.getByRole('button', { name: 'ctaQueue' }));
    expect(onJoinWaitlist).toHaveBeenCalledWith('admin-1');
  });

  it('disables Přidat se do fronty while the queue-target list is still loading', () => {
    // Mirrors the reserve flow's equivalent test: without `queueTargetPending`,
    // one click would call `onJoinWaitlist()` with no argument and queue the
    // spot for the admin, with no selector ever shown.
    renderAdminQueue({ queueTargetOptions: [], queueTargetPending: true });

    expect(screen.getByRole('button', { name: 'ctaQueue' })).toBeDisabled();
  });

  it('offers no selector to a normal user, who still joins for themselves', async () => {
    const { onJoinWaitlist, user } = renderDialog({
      spot: takenByOther,
      viewerUserId: 'user-2',
      queueTargetOptions: [],
    });

    expect(screen.queryByLabelText('queueHolderField')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'ctaQueue' }));
    expect(onJoinWaitlist).toHaveBeenCalledWith();
  });
});
