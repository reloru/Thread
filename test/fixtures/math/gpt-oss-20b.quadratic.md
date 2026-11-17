**1. Solving \(x^{2}-5x+6=0\) with the quadratic formula**

The quadratic formula states that for an equation  

\[
ax^{2}+bx+c=0
\]

the solutions are  

\[
x=\frac{-b\pm\sqrt{b^{2}-4ac}}{2a}.
\]

Here  

\[
a=1,\qquad b=-5,\qquad c=6.
\]

*Step 1 – Compute the discriminant \(D\)*  

\[
D=b^{2}-4ac=(-5)^{2}-4(1)(6)=25-24=1.
\]

*Step 2 – Take the square root of the discriminant*  

\[
\sqrt{D}=\sqrt{1}=1.
\]

*Step 3 – Plug into the formula*  

\[
x=\frac{-(-5)\pm 1}{2(1)}=\frac{5\pm 1}{2}.
\]

*Step 4 – Write the two roots*  

\[
\boxed{x_{1}=\frac{5+1}{2}=3}, \qquad \boxed{x_{2}=\frac{5-1}{2}=2}.
\]

So the equation factors as \((x-2)(x-3)=0\), giving the solutions \(x=2\) and \(x=3\).

---

**2. Integral of \(e^{-x^{2}}\) over the entire real line**

The Gaussian integral is a classic result:

\[
\int_{-\infty}^{\infty} e^{-x^{2}}\,dx = \sqrt{\pi}.
\]

*Sketch of why this is true*  
1. Consider the square of the integral:
   \[
   I = \int_{-\infty}^{\infty} e^{-x^{2}}\,dx, \qquad I^{2} = \left(\int_{-\infty}^{\infty} e^{-x^{2}}\,dx\right)\!\!\left(\int_{-\infty}^{\infty} e^{-y^{2}}\,dy\right).
   \]
2. Convert the double integral to polar coordinates \((r,\theta)\):
   \[
   I^{2} = \int_{0}^{2\pi}\!\!\int_{0}^{\infty} e^{-r^{2}}\,r\,dr\,d\theta.
   \]
3. Compute the radial integral:
   \[
   \int_{0}^{\infty} e^{-r^{2}}\,r\,dr = \frac{1}{2}\int_{0}^{\infty} e^{-u}\,du = \frac{1}{2},
   \]
   where \(u=r^{2}\).
4. Then
   \[
   I^{2} = \int_{0}^{2\pi} \frac{1}{2}\,d\theta = \pi \;\;\Longrightarrow\;\; I = \sqrt{\pi}.
   \]

Thus the integral over all real numbers equals \(\sqrt{\pi}\).

---

**3. Definition of the standard deviation of a sample**

Given a sample of \(n\) observations \(x_{1},x_{2},\dots,x_{n}\):

1. Compute the sample mean (average):

   \[
   \bar{x} = \frac{1}{n}\sum_{i=1}^{n} x_{i}.
   \]

2. Compute the sum of squared deviations from the mean:

   \[
   \sum_{i=1}^{n} (x_{i} - \bar{x})^{2}.
   \]

3. Divide by \(n-1\) (the *degrees of freedom*) to get the *sample variance*:

   \[
   s^{2} = \frac{1}{n-1}\sum_{i=1}^{n} (x_{i} - \bar{x})^{2}.
   \]

4. The *sample standard deviation* is the square root of the variance:

   \[
   \boxed{s = \sqrt{\frac{1}{n-1}\sum_{i=1}^{n} (x_{i} - \bar{x})^{2}} }.
   \]

This \(n-1\) denominator (Bessel’s correction) makes the estimator unbiased for the true population standard deviation when the data are drawn from a normal distribution.