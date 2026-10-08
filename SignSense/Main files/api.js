'use strict';

window.SignSenseApi = {
  url(path) {
    const base = String(window.SIGNSENSE_API_BASE || window.location.origin).replace(/\/$/, '');
    return `${base}${path}`;
  }
};
