
import { configuration } from '@codedoc/core';

import { theme } from './theme';


export const config = /*#__PURE__*/configuration({
  theme,                                  // --> add the theme. modify `./theme.ts` for changing the theme.
  dest: {
    namespace: '/browsercore-fetch'       // --> your github pages namespace. remove if you are using a custom domain.
  },
  page: {
    title: {
      base: 'Browsercore Fetch'           // --> the base title of your doc pages
    }
  },
  misc: {
    github: {
      user: 'jverneuer',                  // --> your github username (where your repo is hosted)
      repo: 'browsercore-fetch',          // --> your github repo name
    }
  },
});
