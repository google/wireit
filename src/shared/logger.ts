import {Event} from './events.js';

export interface Logger {
  log(event: Event): void;
}
