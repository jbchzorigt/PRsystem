import type { ReactNode } from 'react';

export interface Column<T> {
  readonly key: string;
  readonly header: string;
  readonly cell: (row: T) => ReactNode;
}

/**
 * A data table that stays readable on a phone: below 768 px each row becomes a
 * card and each cell carries its header as a label, so nothing ever needs a
 * horizontal scroll to be read (doc 04 §3).
 */
export function Table<T>({
  caption,
  columns,
  rows,
  rowKey,
  empty,
}: {
  readonly caption: string;
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  readonly empty: string;
}) {
  if (rows.length === 0) return <p>{empty}</p>;
  return (
    <div className="table-wrap">
      <table className="stack">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td key={column.key} data-label={column.header}>
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
