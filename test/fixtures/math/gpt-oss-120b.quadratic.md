**1. Solving \(x^{2}-5x+6=0\) with the quadratic formula**

The quadratic formula solves any equation of the form  

\[
ax^{2}+bx+c=0
\]

by  

\[
x=\frac{-b\pm\sqrt{b^{2}-4ac}}{2a}.
\]

For the given equation  

\[
x^{2}-5x+6=0
\]

the coefficients are  

\[
a=1,\qquad b=-5,\qquad c=6.
\]

---

**Step‑by‑step**

| Step | What we do | Result |
|------|------------|--------|
| 1. Write the discriminant | \(D=b^{2}-4ac\) | \(D=(-5)^{2}-4(1)(6)=25-24=1\) |
| 2. Take the square‑root of the discriminant | \(\sqrt{D}\) | \(\sqrt{1}=1\) |
| 3. Plug into the formula | \(x=\dfrac{-b\pm\sqrt{D}}{2a}\) | \(x=\dfrac{-(-5)\pm 1}{2(1)}\) |
| 4. Simplify the numerator | \(-(-5)=5\) | \(x=\dfrac{5\pm 1}{2}\) |
| 5. Compute the two possibilities | • \(x_{1}= \dfrac{5+1}{2}= \dfrac{6}{2}=3\)  <br>• \(x_{2}= \dfrac{5-1}{2}= \dfrac{4}{2}=2\) | \(x_{1}=3,\; x_{2}=2\) |

**Solution:**  

\[
\boxed{x=2\quad\text{or}\quad x=3}
\]

(You can verify: \(2^{2}-5\cdot2+6=0\) and \(3^{2}-5\cdot3+6=0\).)

---

**2. Integral of \(e^{-x^{2}}\) over the whole real line**

The Gaussian integral is a classic result:

\[
\int_{-\infty}^{\infty} e^{-x^{2}}\,dx = \sqrt{\pi}.
\]

*Sketch of the derivation* (optional but helpful)

1. Let \(I = \displaystyle\int_{-\infty}^{\infty} e^{-x^{2}}dx\).
2. Square the integral and change to polar coordinates:  

   \[
   I^{2}= \left(\int_{-\infty}^{\infty} e^{-x^{2}}dx\right)
          \left(\int_{-\infty}^{\infty} e^{-y^{2}}dy\right)
        = \int_{-\infty}^{\infty}\!\!\int_{-\infty}^{\infty}
          e^{-(x^{2}+y^{2})}\,dx\,dy.
   \]

3. In polar coordinates \((r,\theta)\), \(x^{2}+y^{2}=r^{2}\) and \(dx\,dy = r\,dr\,d\theta\):

   \[
   I^{2}= \int_{0}^{2\pi}\!\!\int_{0}^{\infty} e^{-r^{2}}\, r\,dr\,d\theta
        = 2\pi\int_{0}^{\infty} r e^{-r^{2}}dr.
   \]

4. Substitute \(u=r^{2}\) (\(du = 2r\,dr\)):

   \[
   I^{2}= 2\pi \cdot \frac12 \int_{0}^{\infty} e^{-u}\,du
        = \pi \big[ -e^{-u}\big]_{0}^{\infty}
        = \pi.
   \]

5. Hence \(I^{2}= \pi\) and \(I = \sqrt{\pi}\) (positive because the integrand is positive).

So the integral you asked for is \(\boxed{\sqrt{\pi}}\).

---

**3. Definition of the (sample) standard deviation**

Suppose you have a sample of \(n\) observations  

\[
x_{1},\,x_{2},\,\dots,\,x_{n}.
\]

1. **Sample mean (average)**  

   \[
   \bar{x}= \frac{1}{n}\sum_{i=1}^{n} x_{i}.
   \]

2. **Sample variance** (unbiased estimator of the population variance)  

   \[
   s^{2}= \frac{1}{\,n-1\,}\sum_{i=1}^{n}\bigl(x_{i}-\bar{x}\bigr)^{2}.
   \]

   The divisor \(n-1\) (instead of \(n\)) corrects the bias that would otherwise arise because the mean \(\bar{x}\) is itself estimated from the same data.

3. **Sample standard deviation**  

   \[
   s = \sqrt{s^{2}} = 
   \sqrt{ \frac{1}{\,n-1\,}\sum_{i=1}^{n}\bigl(x_{i}-\bar{x}\bigr)^{2} }.
   \]

Thus the standard deviation of a sample is the square root of the average squared deviation of the data points from their sample mean, using \(n-1\) in the denominator to obtain an unbiased estimate of the underlying population’s variability.  

(If you are dealing with a *population* rather than a sample, the denominator would be \(n\) instead of \(n-1\).)

---

**Summary**

* Quadratic equation \(x^{2}-5x+6=0\) → roots \(x=2\) and \(x=3\) (shown step‑by‑step).
* \(\displaystyle\int_{-\infty}^{\infty} e^{-x^{2}}dx = \sqrt{\pi}\).
* Sample standard deviation:  

  \[
  s = \sqrt{\frac{1}{n-1}\sum_{i=1}^{n}(x_{i}-\bar{x})^{2}}.
  \]