/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LitElement, html, css} from 'lit';
import {customElement} from 'lit/decorators.js';

@customElement('wireit-intro-diagram-1')
export class WireitIntroDiagram1 extends LitElement {
  static override styles = css`
    :host {
      display: grid;
      height: 300px;
      border: 1px solid black;
      grid-template: repeat(10, 1fr) / repeat(10, 1fr);
      grid-gap: 1em;
      padding: 1em;
    }
    div {
      background: black;
      color: white;
      border-radius: 5px;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 5px 20px;
    }
    #start {
      grid-row: 1;
      grid-column: 5;
    }
    #build {
      grid-row: 4;
      grid-column: 5;
    }
    #lint {
      grid-row: 4;
      grid-column: 6;
    }
    #build_client {
      grid-row: 8;
      grid-column: 4;
    }
    #build_server {
      grid-row: 8;
      grid-column: 7;
    }
  `;

  override render() {
    return html`
      <div id="start">start</div>
      <div id="build">build</div>
      <div id="lint">lint</div>
      <div id="build_client">build:client</div>
      <div id="build_server">build:server</div>
    `;
  }
}
