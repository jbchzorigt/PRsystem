// Deliberate module-boundary violation.
//
// This file is NOT part of any build or workspace package. It exists so that
// packages/testing/src/eslint-boundary.test.ts can prove the boundary rule
// actually reports an error. If ESLint stops flagging this file, that test fails.
//
// eslint-disable is intentionally NOT used here.
import { FolioRepository } from '../../apps/api/src/modules/folio/repositories/folio.repository';

export const violation = FolioRepository;
