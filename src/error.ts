/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Failure} from './event.js';

/**
 * A known Wireit error.
 *
 * All errors that Wireit can anticipate should be an instance of this class.
 * Any other exception that is raised to the top-level should be considered a
 * bug.
 */
export class WireitError extends Error {
  event: Failure;

  /**
   * @param event The failure event that caused this exception.
   */
  constructor(event: Failure) {
    // Note that we need to pass some message for the base class, but it won't
    // usually be used. Most details are contained by the event, which can be
    // displayed nicely to the user by passing to a Logger instance.
    super(event.reason);
    this.event = event;
  }
}
