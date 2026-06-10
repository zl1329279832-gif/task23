export function required(value, label) {
  if (value === null || value === undefined || value === '') {
    return `${label}不能为空`;
  }
  return null;
}

export function numberRange(value, min, max, label) {
  const num = Number(value);
  if (isNaN(num)) return `${label}必须是数字`;
  if (num < min || num > max) return `${label}应在 ${min}-${max} 之间`;
  return null;
}

export function bloodPressure(systolic, diastolic) {
  const errors = [];
  const s = Number(systolic);
  const d = Number(diastolic);
  if (systolic && (isNaN(s) || s < 60 || s > 300)) errors.push('收缩压应在 60-300 mmHg');
  if (diastolic && (isNaN(d) || d < 30 || d > 200)) errors.push('舒张压应在 30-200 mmHg');
  if (s && d && s <= d) errors.push('收缩压应大于舒张压');
  return errors.length ? errors : null;
}

export function bloodGlucose(value) {
  const v = Number(value);
  if (isNaN(v) || v < 1 || v > 40) return '血糖值应在 1-40 mmol/L';
  return null;
}

export function validateForm(fields) {
  const errors = {};
  let valid = true;
  for (const [key, checks] of Object.entries(fields)) {
    for (const check of checks) {
      const error = check();
      if (error) {
        errors[key] = error;
        valid = false;
        break;
      }
    }
  }
  return { valid, errors };
}
