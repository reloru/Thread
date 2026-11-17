# Part 1: Solving x² − 5x + 6 = 0

**Step 1 — Identify the coefficients** by comparing to ax² + bx + c = 0:
- a = 1, b = −5, c = 6

**Step 2 — Write down the quadratic formula:**

$$x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$$

**Step 3 — Compute the discriminant:**

$$b^2 - 4ac = (-5)^2 - 4(1)(6) = 25 - 24 = 1$$

Since the discriminant is positive, there are two distinct real roots.

**Step 4 — Substitute into the formula:**

$$x = \frac{-(-5) \pm \sqrt{1}}{2(1)} = \frac{5 \pm 1}{2}$$

**Step 5 — Compute both roots:**

$$x_1 = \frac{5+1}{2} = 3, \qquad x_2 = \frac{5-1}{2} = 2$$

**Check:** 3² − 5(3) + 6 = 9 − 15 + 6 = 0 ✓ and 2² − 5(2) + 6 = 4 − 10 + 6 = 0 ✓

So the solutions are **x = 2 and x = 3** (consistent with the factored form (x−2)(x−3) = 0).

# Part 2: The Gaussian integral

$$\int_{-\infty}^{\infty} e^{-x^2}\, dx = \sqrt{\pi} \approx 1.7725$$

This is the famous **Gaussian integral**. A classic proof: let I be the integral, then square it and interpret as a double integral over the plane:

$$I^2 = \int_{-\infty}^{\infty}\int_{-\infty}^{\infty} e^{-(x^2+y^2)}\, dx\, dy$$

Switching to polar coordinates (x² + y² = r², dx dy = r dr dθ):

$$I^2 = \int_0^{2\pi}\!\!\int_0^\infty e^{-r^2} r\, dr\, dθ = 2\pi \cdot \frac{1}{2} = \pi$$

so I = √π (taking the positive root since the integrand is positive).

# Part 3: Sample standard deviation

Given a sample x₁, x₂, …, xₙ, the **sample standard deviation** is:

$$s = \sqrt{\frac{1}{n-1}\sum_{i=1}^{n}(x_i - \bar{x})^2}$$

where x̄ = (1/n)Σxᵢ is the **sample mean**.

In words: take each data point's squared deviation from the mean, average them using a divisor of **n − 1** instead of n, then take the square root.

**Why n − 1?** This is *Bessel's correction*. The deviations (xᵢ − x̄) are computed relative to the sample mean rather than the true population mean, which forces them to sum to zero — one "degree of freedom" is already used up. Dividing by n − 1 instead of n makes s² an unbiased estimator of the population variance. (By contrast, the *population* standard deviation, when you have all N values of a full population, divides by N.)