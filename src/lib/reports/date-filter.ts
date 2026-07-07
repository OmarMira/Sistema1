export function toUTCRange(startDateStr?: string | null, endDateStr?: string | null) {
  const now = new Date();

  let startYear = now.getUTCFullYear();
  let startMonth = 0;
  let startDay = 1;

  if (startDateStr) {
    const parts = startDateStr.split('-');
    if (parts.length === 3) {
      startYear = parseInt(parts[0], 10);
      startMonth = parseInt(parts[1], 10) - 1;
      startDay = parseInt(parts[2], 10);
    }
  }

  let endYear = now.getUTCFullYear();
  let endMonth = 11;
  let endDay = 31;

  if (endDateStr) {
    const parts = endDateStr.split('-');
    if (parts.length === 3) {
      endYear = parseInt(parts[0], 10);
      endMonth = parseInt(parts[1], 10) - 1;
      endDay = parseInt(parts[2], 10);
    }
  }

  const startDate = new Date(Date.UTC(startYear, startMonth, startDay, 0, 0, 0, 0));
  const endDate = new Date(Date.UTC(endYear, endMonth, endDay, 23, 59, 59, 999));

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    throw new Error('Formato de fecha inválido');
  }

  if (startDate > endDate) {
    throw new Error('La fecha de inicio debe ser menor o igual a la fecha de fin');
  }

  return { startDate, endDate };
}
